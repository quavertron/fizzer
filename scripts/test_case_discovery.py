"""Discover Node test names with a Python AST reader; never import test files."""

import ast
import re

from tree_sitter import Language, Parser
import tree_sitter_typescript

TEST_CALL = re.compile(r"^(?:test|it|describe|suite|t\.test)(?:\.(?:skip|only|todo))?$")


def text(node):
    return node.text.decode()


def bind(node, value, scope):
    if node.type == "identifier":
        scope[text(node)] = value
    elif node.type == "array_pattern":
        for child, item in zip(node.named_children, value):
            bind(child, item, scope)
    else:
        raise ValueError(f"Unsupported test-name binding: {text(node)}")


def literal(node, scope):
    kind = node.type
    children = node.named_children
    if kind == "string":
        return ast.literal_eval(text(node))
    if kind == "number":
        return float(text(node)) if "." in text(node) else int(text(node))
    if kind in ("true", "false"):
        return kind == "true"
    if kind == "identifier" and text(node) in scope:
        return scope[text(node)]
    if kind in ("arrow_function", "function_expression"):
        return None  # Only keys matter in maps whose values are test callbacks.
    if kind in ("parenthesized_expression", "as_expression"):
        return literal(children[0], scope)
    if kind == "array":
        return [literal(child, scope) for child in children]
    if kind == "object":
        result = {}
        for child in children:
            if child.type == "spread_element":
                result.update(literal(child.named_children[0], scope))
            elif child.type == "pair":
                key = child.child_by_field_name("key")
                key = literal(key, scope) if key.type == "string" else text(key)
                result[key] = literal(child.child_by_field_name("value"), scope)
            else:
                raise ValueError(f"Unsupported test-name object: {text(child)}")
        return result
    if kind == "template_string":
        parts = []
        for child in children:
            if child.type == "template_substitution":
                value = literal(child.named_children[0], scope)
                parts.append(str(value).lower() if isinstance(value, bool) else str(value))
            elif child.type == "string_fragment":
                parts.append(text(child))
            elif child.type == "escape_sequence":
                parts.append(ast.literal_eval('"' + text(child) + '"'))
            else:
                raise ValueError(f"Unsupported test-name template: {text(child)}")
        return "".join(parts)
    if kind == "ternary_expression":
        field = "consequence" if literal(node.child_by_field_name("condition"), scope) else "alternative"
        return literal(node.child_by_field_name(field), scope)
    if kind == "binary_expression":
        a = literal(node.child_by_field_name("left"), scope)
        b = literal(node.child_by_field_name("right"), scope)
        operator = text(node.child_by_field_name("operator"))
        if operator == "-":
            return a - b
        if operator == "+":
            return a + b
        if operator == "===":
            return type(a) is type(b) and a == b
    if kind == "call_expression":
        fn = node.child_by_field_name("function")
        args = node.child_by_field_name("arguments").named_children
        if text(fn) == "Object.entries":
            return list(literal(args[0], scope).items())
        if text(fn) == "Object.fromEntries":
            return dict(literal(args[0], scope))
        if fn.type == "member_expression" and text(fn.child_by_field_name("property")) == "map":
            callback = args[0]
            if callback.type != "arrow_function":
                raise ValueError("Nonliteral map callback")
            parameters = callback.child_by_field_name("parameters")
            parameter = parameters.named_children[0] if parameters else callback.child_by_field_name("parameter")
            if parameter.type == "required_parameter":
                parameter = parameter.child_by_field_name("pattern")
            result = []
            for item in literal(fn.child_by_field_name("object"), scope):
                nested = dict(scope)
                bind(parameter, item, nested)
                result.append(literal(callback.child_by_field_name("body"), nested))
            return result
    raise ValueError(f"Cannot statically resolve test name: {text(node)}")


def has_tests(node):
    if node.type == "call_expression" and TEST_CALL.fullmatch(text(node.child_by_field_name("function"))):
        return True
    return any(has_tests(child) for child in node.named_children)


def node_cases(root, files):
    parser = Parser(Language(tree_sitter_typescript.language_typescript()))
    cases = []
    for file in files:
        tree = parser.parse((root / file).read_bytes())
        if tree.root_node.has_error:
            raise ValueError(f"Cannot parse test file {file}")

        def visit(node, scope, ancestors=()):
            kind = node.type
            if kind == "variable_declarator":
                name, value = node.child_by_field_name("name"), node.child_by_field_name("value")
                if value:
                    try:
                        bind(name, literal(value, scope), scope)
                    except (ValueError, TypeError, KeyError):
                        pass  # Runtime fixture values are not needed for names.
                return
            if kind == "for_in_statement":
                body = node.child_by_field_name("body")
                if not has_tests(body):
                    return
                for value in literal(node.child_by_field_name("right"), scope):
                    nested = dict(scope)
                    bind(node.child_by_field_name("left"), value, nested)
                    visit(body, nested, ancestors)
                return
            if kind == "call_expression":
                call = text(node.child_by_field_name("function"))
                if TEST_CALL.fullmatch(call):
                    if call.endswith((".skip", ".todo")):
                        return
                    args = node.child_by_field_name("arguments").named_children
                    name = literal(args[0], scope)
                    if not isinstance(name, str):
                        raise ValueError(f"Non-string test name in {file}")
                    full = (*ancestors, name)
                    count = len(cases)
                    for arg in args[1:]:
                        if arg.type in ("arrow_function", "function_expression"):
                            visit(arg.child_by_field_name("body"), dict(scope), full)
                    if not call.startswith(("describe", "suite")) and count == len(cases):
                        cases.append({"file": file, "name": " ".join(full),
                                      "ancestors": [" ".join(ancestors[:i + 1]) for i in range(len(ancestors))]})
                    return
            if kind in ("function_declaration", "arrow_function", "function_expression"):
                return
            for child in node.named_children:
                visit(child, scope, ancestors)

        try:
            visit(tree.root_node, {})
        except (ValueError, TypeError, KeyError) as error:
            raise ValueError(f"Cannot discover individual tests in {file}: {error}") from error
    for case in cases:
        case["exclude"] = [other["name"] for other in cases
                           if other["file"] == case["file"] and other["name"] != case["name"]]
    return cases
