defmodule Cascade.Chat.HistoryPageTest do
  use ExUnit.Case, async: false
  import Plug.Conn
  import Plug.Test
  alias Cascade.Accounts.SQL
  alias Cascade.Chat.Messages
  alias Cascade.Content.Store

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
