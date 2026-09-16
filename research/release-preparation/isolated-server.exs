System.put_env("JWT_SECRET", "bf273e-synthetic-isolated-review")
alias Cascade.Accounts.SQL
alias Cascade.Content.Store
root = Path.join(System.tmp_dir!(), "bf273e-http-#{System.pid()}")
SQL.exec("INSERT INTO users (username,password_hash,display_name,avatar_url) VALUES (?,?,?,?)", ["fixture", "x", "Fixture", ""])
id = SQL.last_insert_id()
SQL.exec("INSERT INTO vaults (id,name,root_path,created_by) VALUES (?,?,?,?)", ["v0", "Fixture", root, id])
SQL.exec("INSERT INTO vault_members (vault_id,user_id,role,invited_by) VALUES (?,?,?,?)", ["v0", id, "owner", id])
board = "---\nkanban-plugin: board\nsuperkanban: true\n---\n## Queue\n- [ ] First\n- [ ] Second\n\n## Accepted\n- [ ] Existing\n"
a = Store.create_note("v0", id, %{id: "a", title: "Fixture a", content: board, is_listed: true})
b = Store.create_note("v0", id, %{id: "b", title: "Fixture b", content: "Other", is_listed: true})
token = Cascade.Auth.Token.sign_user(%{id: id, username: "fixture", auth_version: 0})
{:ok, server} = Bandit.start_link(plug: CascadeWeb.Router, scheme: :http, ip: {127,0,0,1}, port: 0)
{:ok, {_ip, port}} = ThousandIsland.listener_info(server)
File.write!("/tmp/bf273e-server.json", Jason.encode!(%{port: port, token: token, root: root, files: %{a: a.file_path, b: b.file_path}}))
IO.puts("Isolated backend ready on loopback port #{port}")
Process.sleep(:infinity)
