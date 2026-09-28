defmodule Cascade.Realtime.RunReceiptsTest do
  use ExUnit.Case, async: false
  alias Cascade.Realtime.DomainAdapter
  alias Cascade.Runs.Store

  setup do
    ctx = Cascade.TestHelpers.owner_vault("run-receipts")

    {:ok, run} =
      Store.start(ctx.vault_id, nil, "Receipt test", "codex", owner_user_id: ctx.user_id)

    Store.record_delegated(run.id, ctx.user_id)
    Map.put(ctx, :run, run)
  end

  test "owner can forward final lock cleanup after run settlement", ctx do
    terminal(ctx)
    data = %{runId: ctx.run.id, type: "activity", payload: %{"kind" => "lock", "result" => "released", "file" => "note", "agent" => "Codex"}}
    assert {:error, _} = DomainAdapter.handle_event("/runners", "runner:runEvent", [data], %{id: ctx.user_id + 1}, %{})
    assert {:ok, _} = DomainAdapter.handle_event("/runners", "runner:runEvent", [data], %{id: ctx.user_id}, %{})
    assert Enum.any?(Cascade.Activity.replay(ctx.vault_id, %{}).events, &(&1["result"] == "released"))
  end

  test "edit counts survive completion and replay without crossing runs", ctx do
    # Replayed edits must preserve the completed turn's totals without doubling them.
    channel = Cascade.Content.Store.create_note(ctx.vault_id, ctx.user_id, %{title: "Counters", content: "cascade://chat-channel"})
    {:ok, message} = Cascade.Chat.Messages.create(%{id: ctx.user_id, username: ctx.username}, ctx.vault_id, channel.id, %{body: "Working"})
    Cascade.Accounts.SQL.exec("UPDATE chat_messages SET run_id=? WHERE id=?", [ctx.run.id, message.id])
    payload = %{"kind" => "edit", "id" => "event-1", "diffCounts" => %{"adds" => 2, "mods" => 3, "moves" => 4, "dels" => 1}}
    data = %{runId: ctx.run.id, type: "activity", payload: payload}
    assert {:error, _} = DomainAdapter.handle_event("/runners", "runner:runEvent", [data], %{id: ctx.user_id + 1}, %{})
    assert Store.edit_counts(ctx.run.id) == nil
    for _ <- 1..2 do
      assert {:ok, _} = DomainAdapter.handle_event("/runners", "runner:runEvent", [data], %{id: ctx.user_id}, %{})
    end
    assert Store.edit_counts(ctx.run.id) == payload["diffCounts"]
    terminal(ctx)
    assert Store.edit_counts(ctx.run.id) == payload["diffCounts"]
    {:ok, reloaded} = Cascade.Chat.Messages.get(channel.id, ctx.user_id, message.id)
    assert reloaded.diffCounts == payload["diffCounts"]
    assert length(Enum.filter(Store.events(ctx.run.id), &(&1.type == "edit_counts"))) == 1
    {:ok, next} = Store.start(ctx.vault_id, nil, "Next turn", "codex", owner_user_id: ctx.user_id)
    assert Store.edit_counts(next.id) == nil
    Store.record_edit_counts(ctx.run.id, Map.put(payload, "id", "event-2"))
    assert Store.edit_counts(ctx.run.id)["adds"] == 4
    Store.record_edit_counts(ctx.run.id, %{payload | "id" => "invalid", "diffCounts" => %{"adds" => -1}})
    assert Store.edit_counts(ctx.run.id)["adds"] == 4
  end

  defp terminal(ctx, status \\ "completed") do
    DomainAdapter.handle_event(
      "/runners",
      "runner:runEvent",
      [
        %{
          runId: ctx.run.id,
          type: "status",
          receipt: true,
          payload: %{status: status, summary: "Verified result"}
        }
      ],
      %{id: ctx.user_id},
      %{}
    )
  end

  test "native running status and heartbeats acknowledge delivery and update stored state once",
       ctx do
    Store.record_delegated(ctx.run.id, ctx.user_id, %{runId: ctx.run.id, prompt: "same payload"})
    data = %{runId: ctx.run.id, type: "heartbeat", payload: %{}}

    assert {:error, _} =
             DomainAdapter.handle_event(
               "/runners",
               "runner:runEvent",
               [data],
               %{id: ctx.user_id + 1},
               %{}
             )

    assert is_list(Store.pending_delivery(ctx.run.id, ctx.user_id))

    assert {:ok, []} =
             DomainAdapter.handle_event(
               "/runners",
               "runner:runEvent",
               [data],
               %{id: ctx.user_id},
               %{}
             )

    assert Store.get(ctx.run.id).status == "running"
    assert is_nil(Store.pending_delivery(ctx.run.id, ctx.user_id))
    events = Store.events(ctx.run.id)

    assert {:ok, []} =
             DomainAdapter.handle_event(
               "/runners",
               "runner:runEvent",
               [%{data | type: "status", payload: %{status: "running"}}],
               %{id: ctx.user_id},
               %{}
             )

    assert Store.events(ctx.run.id) == events
    Store.finish(ctx.run.id, "canceled", "Explicit Stop")

    assert {:error, :run_not_active} =
             Store.record_delegated(ctx.run.id, ctx.user_id, %{runId: ctx.run.id})

    assert is_nil(Store.delegated_owner(ctx.run.id))
  end

  test "a lost receipt replays idempotently after delegation ownership is cleared", ctx do
    assert {:ok, [{:ack, [%{success: true}]}]} = terminal(ctx)
    assert Store.get(ctx.run.id).status == "completed"
    assert Store.get(ctx.run.id).summary == "Verified result"
    assert is_nil(Store.delegated_owner(ctx.run.id))
    events = Store.events(ctx.run.id)
    assert {:ok, [{:ack, [%{success: true}]}]} = terminal(ctx)
    assert Store.events(ctx.run.id) == events
    assert {:error, "Run event rejected"} = terminal(%{ctx | user_id: ctx.user_id + 1})
  end

  test "receipt repairs finish-before-publish without reversing an authoritative stop", ctx do
    Store.finish(ctx.run.id, "canceled", "User stopped it")
    assert {:ok, [{:ack, [%{success: true}]}]} = terminal(ctx)
    assert Store.get(ctx.run.id).status == "canceled"
    final = Store.events(ctx.run.id) |> List.last()
    assert Jason.decode!(final.payload_json)["status"] == "canceled"
    assert Jason.decode!(final.payload_json)["summary"] == "User stopped it"
  end
end
