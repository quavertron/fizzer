defmodule Cascade.Chat.HistoryPageTest do
  use ExUnit.Case, async: false
  import Plug.Conn
  import Plug.Test
  alias Cascade.Accounts.SQL
  alias Cascade.Chat.Messages
  alias Cascade.Content.Store

  test "empty history is removed without losing media, cards, active work or retrievable records" do
    c = Cascade.TestHelpers.owner_vault("empty-history")
    user = %{id: c.user_id, username: c.username}

    channel =
      Store.create_note(c.vault_id, user.id, %{
        title: "History",
        content: "cascade://chat-channel"
      })

    for body <- ["", " \n\t", "<!-- fizzer-next-none:handled -->"] do
      assert {:error, "Message must contain text, media or a card"} =
               Messages.create(user, c.vault_id, channel.id, %{body: body})
    end

    retained =
      for content <- [
            %{images: ["data:image/png;base64,eA=="]},
            %{attachments: [%{name: "evidence.txt", url: "/evidence.txt"}]},
            %{mission: %{id: "mission", title: "Owned work"}},
            %{clarification: %{questions: [%{prompt: "Which scope?"}]}},
            %{changeRequest: %{files: [%{path: "file.txt", additions: 0.0, deletions: 0.0}]}},
            %{blocks: [%{type: "text", text: "Useful block-only content"}]},
            %{blocks: [%{type: "tool_use", name: "Read"}]},
            %{harnessLog: "Verified revision"},
            %{status: "queued"},
            %{status: "sending"},
            %{status: "running"},
            %{status: "failed"}
          ] do
        assert {:ok, row} =
                 Messages.create(user, c.vault_id, channel.id, Map.put(content, :body, ""))

        row.id
      end

    hidden =
      for agent <- [nil, "codex"] do
        {:ok, row} = Messages.create(user, c.vault_id, channel.id, %{body: "Old content"})

        SQL.exec("UPDATE chat_messages SET body='  ',agent_id=?,status='completed' WHERE id=?", [
          agent,
          row.id
        ])

        # Direct retrieval keeps ids needed by replies, dispatch cursors and audits.
        assert {:ok, _} = Messages.get(channel.id, user.id, row.id)
        row.id
      end

    {:ok, rows} = Messages.list(channel.id, user.id)
    assert Enum.sort(Enum.map(rows, & &1.id)) == Enum.sort(retained)
    refute Enum.any?(rows, &(&1.id in hidden))
    assert Enum.any?(rows, & &1[:hasImages])
    assert Enum.any?(rows, & &1[:hasHarness])
    assert Messages.terminal_shell?(%{"body" => " ", "status" => "completed"})
    assert Messages.terminal_shell?(%{body: "", blocks: [%{type: "thinking", text: " "}]})
  end

  test "raw cursors cross hidden pages without false exhaustion and stay scoped to a channel" do
    c = Cascade.TestHelpers.owner_vault("history-page")
    user = %{id: c.user_id, username: c.username}

    channel =
      Store.create_note(c.vault_id, user.id, %{
        title: "History",
        content: "cascade://chat-channel"
      })

    rows =
      for i <- 1..9 do
        {:ok, row} = Messages.create(user, c.vault_id, channel.id, %{body: "Message #{i}"})
        row
      end

    for row <- Enum.slice(rows, 3, 3) do
      SQL.exec(
        "UPDATE chat_messages SET agent_id='codex',status='completed',body='' WHERE id=?",
        [row.id]
      )
    end

    {:ok, recent} = Messages.list(channel.id, user.id, page: true, limit: 3)
    assert Enum.map(recent.messages, & &1.id) == Enum.map(Enum.drop(rows, 6), & &1.id)
    assert recent.hasMore

    {:ok, hidden} =
      Messages.list(channel.id, user.id, page: true, limit: 3, before_seq: recent.beforeSeq)

    assert hidden.messages == []
    assert hidden.hasMore
    assert hidden.beforeSeq < recent.beforeSeq

    {:ok, first} =
      Messages.list(channel.id, user.id, page: true, limit: 3, before_seq: hidden.beforeSeq)

    assert Enum.map(first.messages, & &1.id) == Enum.map(Enum.take(rows, 3), & &1.id)
    refute first.hasMore
    token = Cascade.Auth.Token.sign_user(%{id: user.id, username: user.username, auth_version: 0})

    response =
      conn(
        :get,
        "/api/vaults/#{c.vault_id}/channels/#{channel.id}/messages?limit=3&beforeSeq=#{recent.beforeSeq}"
      )
      |> put_req_header("authorization", "Bearer " <> token)
      |> CascadeWeb.ChatRouter.call(CascadeWeb.ChatRouter.init([]))

    assert response.status == 200

    assert Jason.decode!(response.resp_body) == %{
             "messages" => [],
             "beforeSeq" => hidden.beforeSeq,
             "hasMore" => true
           }

    outsider = Cascade.TestHelpers.owner_vault("history-outsider")

    assert {:error, _} =
             Messages.list(channel.id, outsider.user_id, page: true, before_seq: recent.beforeSeq)
  end
end
