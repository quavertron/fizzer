defmodule Cascade.Runs.ChatProjectionTest do
  use ExUnit.Case, async: true

  alias Cascade.Runs.ChatProjection

  test "folds visible text, structured blocks, harness output, and final summaries" do
    content =
      ChatProjection.build([
        event("status", %{status: "queued"}),
        event("text", %{
          message: %{
            content: [
              %{type: "thinking", thinking: "checking"},
              %{type: "text", text: "draft "},
              %{type: "tool_use", id: "tool-1", name: "Read", input: %{path: "a"}}
            ]
          }
        }),
        event("text", %{
          chatVisible: true,
          message: %{
            content: [
              %{type: "text", text: "answer"},
              %{type: "tool_use", id: "tool-1", name: "Read", input: %{path: "b"}}
            ]
          }
        }),
        event("harness", %{data: "trace"}),
        event("status", %{status: "completed", summary: "Final answer"})
      ])

    assert content.body == "Final answer"
    assert content.harnessLog == "trace"
    assert content.status == nil
    assert content.terminal_status == "completed"
    assert content.done
    assert Enum.at(content.blocks, 1) == %{type: "text", text: "draft "}
    assert Enum.at(content.blocks, 2).input == %{"path" => "b"}
    assert Enum.at(content.blocks, 3) == %{type: "text", text: "answer"}
  end

  test "preserves useful work on failure and honors suppressed terminal shells" do
    failed =
      ChatProjection.build([
        event("text", %{chatVisible: true, message: %{content: "partial work"}}),
        event("status", %{status: "failed", summary: "usage limit"})
      ])

    assert failed.body == "partial work\n\n> ⚠️ usage limit"
    assert failed.status == "failed"
    assert failed.terminal_status == "failed"

    suppressed =
      ChatProjection.build([
        event("text", %{chatVisible: true, message: %{content: "duplicate"}}),
        event("status", %{status: "canceled", suppressChatBody: true})
      ])

    assert suppressed.body == ""
    assert suppressed.done
  end

  test "keeps an outcome paragraph after an initial progress sentence" do
    body = "I'll inspect the scroll behavior.\n\nLive traces now follow the transcript pin."

    projected =
      ChatProjection.build([
        event("text", %{chatVisible: true, message: %{content: body}}),
        event("status", %{status: "completed", summary: body})
      ])

    assert projected.body == body
    assert projected.done
  end

  test "chunked project matches a single full rebuild" do
    events =
      [
        event("status", %{status: "queued"}, 1),
        event("text", %{message: %{content: "Hel"}}, 2),
        event("text", %{chatVisible: true, message: %{content: "lo "}}, 3),
        event("harness", %{data: "trace-a"}, 4),
        event("text", %{chatVisible: true, message: %{content: "world"}}, 5),
        event("harness", %{data: "-b"}, 6),
        event("status", %{status: "completed", summary: "Hello world"}, 7)
      ]

    full = ChatProjection.build(events)
    {first, rest} = Enum.split(events, 2)
    {partial, cursor} = ChatProjection.project(first)
    {chunked, next} = ChatProjection.project(rest, cursor)

    assert partial.body == "Thinking..."
    assert partial.status == "running"
    assert cursor.last_seq == 2
    assert chunked == full
    assert next.last_seq == 7
    assert chunked.body == "Hello world"
    assert chunked.harnessLog == "trace-a-b"
  end

  test "projecting no new events keeps the cursor and content" do
    events = [
      event("text", %{chatVisible: true, message: %{content: "stable"}}, 1),
      event("harness", %{data: "log"}, 2)
    ]

    {content, cursor} = ChatProjection.project(events)
    {again, same} = ChatProjection.project([], cursor)

    assert again == content
    assert same.last_seq == 2
    assert content.body == "stable"
    assert content.harnessLog == "log"
  end

  test "final-reply-only streams public decal text without chat chatter or terminal residue" do
    live =
      ChatProjection.build(
        [
          event("text", %{
            chatVisible: true,
            message: %{
              content: [
                %{type: "thinking", thinking: "checking"},
                %{type: "text", text: "I am checking"}
              ]
            }
          }),
          event("harness", %{data: "tool trace"})
        ],
        true
      )

    assert live.body == "Thinking..."
    assert live.blocks == [%{type: "text", text: "I am checking"}]
    assert live.harnessLog == ""

    settled =
      ChatProjection.build(
        [
          event("text", %{chatVisible: true, message: %{content: "I am checking"}}),
          event("text", %{
            chatVisible: true,
            message: %{content: "The storage invariant is still violated."}
          }),
          event("status", %{status: "completed"})
        ],
        true
      )

    assert settled.body == "The storage invariant is still violated."
    assert settled.blocks == []

    silent =
      ChatProjection.build(
        [
          event("text", %{chatVisible: true, message: %{content: "[no-reply]"}}),
          event("status", %{status: "completed", summary: "[no-reply]"})
        ],
        true
      )

    assert silent.body == ""
    assert silent.done
  end

  defp event(type, payload, seq \\ nil) do
    base = %{type: type, payload_json: Jason.encode!(payload)}
    if seq, do: Map.put(base, :seq, seq), else: base
  end
end
