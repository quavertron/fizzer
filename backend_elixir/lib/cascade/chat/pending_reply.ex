defmodule Cascade.Chat.PendingReply do
  @moduledoc "Retracts a dispatch's placeholder only while no run has claimed it."
  alias Cascade.Accounts.SQL
  alias Cascade.Realtime.Events

  def retract(dispatch_id) do
    SQL.transaction(fn ->
      reply_id = "agent-dispatch-#{dispatch_id}"

      with nil <- SQL.one("SELECT 1 FROM runs WHERE chat_dispatch_id=? LIMIT 1", [dispatch_id]),
           [vault_id, channel_id] <-
             SQL.one(
               "SELECT vault_id,channel_id FROM chat_messages WHERE id=? AND run_id IS NULL",
               [reply_id]
             ) do
        SQL.exec("DELETE FROM chat_messages WHERE id=?", [reply_id])

        Events.emit(%{
          event: "vault:chatMessageDeleted",
          vaultId: vault_id,
          channelId: channel_id,
          messageId: reply_id
        })
      else
        _ -> :ok
      end
    end)
  end
end
