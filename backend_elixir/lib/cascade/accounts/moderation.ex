defmodule Cascade.Accounts.Moderation do
  @moduledoc "Vault bans and accountable, bounded content reports."

  alias Cascade.Accounts.{DirectMessages, SQL, VaultMembers}
  alias Cascade.Auth.Accounts

  @reasons ~w(spam harassment hate illegal other)
  @targets ~w(vault note message member)
  @statuses ~w(open dismissed resolved)
  @detail_max 500

  def report_status?(value), do: value in @statuses
  def server_owner?(user_id), do: Accounts.owner?(user_id)

  def banned?(vault_id, user_id),
    do:
      SQL.one("SELECT 1 FROM vault_bans WHERE vault_id = ? AND user_id = ?", [vault_id, user_id]) !=
        nil

  def list_bans(vault_id, actor_id) do
    if VaultMembers.role(vault_id, actor_id) != "owner" do
      {:error, "Only the vault owner can manage bans"}
    else
      bans =
        SQL.all(
          """
          SELECT b.user_id,u.username,COALESCE(NULLIF(u.display_name,''),u.username),
            COALESCE(u.avatar_url,''),b.reason,b.banned_by,b.created_at
          FROM vault_bans b JOIN users u ON u.id=b.user_id WHERE b.vault_id=?
          ORDER BY b.created_at DESC,u.username COLLATE NOCASE
          """,
          [vault_id]
        )
        |> Enum.map(fn [
                         user_id,
                         username,
                         display_name,
                         avatar_url,
                         reason,
                         banned_by,
                         created_at
                       ] ->
          %{
            userId: user_id,
            username: username,
            displayName: display_name,
            avatarUrl: avatar_url,
            reason: reason,
            bannedBy: banned_by,
            createdAt: created_at
          }
        end)

      {:ok, bans}
    end
  end

  def ban(vault_id, actor_id, target_id, reason_raw \\ nil) do
    vault = vault(vault_id)
    reason = reason_raw |> to_string() |> String.trim()

    cond do
      is_nil(vault) ->
        {:error, "Vault not found"}

      VaultMembers.role(vault_id, actor_id) != "owner" ->
        {:error, "Only the vault owner can ban members"}

      not is_integer(target_id) or target_id < 1 ->
        {:error, "Invalid user id"}

      target_id == vault.created_by or VaultMembers.role(vault_id, target_id) == "owner" ->
        {:error, "The vault owner cannot be banned"}

      String.length(reason) > @detail_max ->
        {:error, "Reason must be 500 characters or fewer"}

      true ->
        persist_ban(vault_id, actor_id, target_id, reason)
    end
  end

  def unban(vault_id, actor_id, target_id) do
    cond do
      VaultMembers.role(vault_id, actor_id) != "owner" ->
        {:error, "Only the vault owner can manage bans"}

      not is_integer(target_id) or target_id < 1 ->
        {:error, "Invalid user id"}

      SQL.changes("DELETE FROM vault_bans WHERE vault_id=? AND user_id=?", [vault_id, target_id]) ==
          0 ->
        {:error, "That user is not banned"}

      true ->
        :ok
    end
  end

  def create_report(input) do
    requested = vault(input.vault_id)
    target_type = input.target_type
    reason = input.reason
    target_id = input.target_id |> to_string() |> String.trim()
    detail = input.detail |> to_string() |> String.trim()

    cond do
      is_nil(requested) ->
        {:error, "Vault not found"}

      target_type not in @targets ->
        {:error, "Report target must be a vault, note, message, or member"}

      reason not in @reasons ->
        {:error, "Reason must be one of: #{Enum.join(@reasons, ", ")}"}

      target_id == "" ->
        {:error, "Report target is required"}

      String.length(detail) > @detail_max ->
        {:error, "Details must be 500 characters or fewer"}

      true ->
        validate_and_insert_report(
          requested,
          input.reporter_user_id,
          target_type,
          target_id,
          reason,
          detail
        )
    end
  end

  def list_vault_reports(vault_id, actor_id, status \\ "open") do
    current = vault(vault_id)

    cond do
      is_nil(current) ->
        {:error, "Vault not found"}

      VaultMembers.role(vault_id, actor_id) != "owner" ->
        {:error, "Only the vault owner can review reports"}

      true ->
        reports =
          SQL.all(
            """
            SELECT r.id,r.vault_id,r.target_type,r.target_id,
              (SELECT u.username FROM users u WHERE r.target_type='member' AND u.id=CAST(r.target_id AS INTEGER)),
              r.reason,r.detail,r.status,r.created_at,r.reviewed_at
            FROM content_reports r WHERE r.vault_id=? AND r.target_type!='vault'
              AND NOT (r.target_type='member' AND CAST(r.target_id AS INTEGER)=?)
              AND (?='all' OR r.status=?) ORDER BY r.created_at DESC,r.id DESC LIMIT 200
            """,
            [vault_id, current.created_by, status, status]
          )
          |> Enum.map(&map_report/1)

        {:ok, reports}
    end
  end

  def review_vault_report(vault_id, report_id, actor_id, action) do
    current = vault(vault_id)

    cond do
      is_nil(current) ->
        {:error, "Vault not found"}

      VaultMembers.role(vault_id, actor_id) != "owner" ->
        {:error, "Only the vault owner can review reports"}

      action not in ["dismiss", "resolve"] ->
        {:error, "Action must be dismiss or resolve"}

      true ->
        case SQL.one(
               """
               SELECT id FROM content_reports WHERE id=? AND vault_id=? AND target_type!='vault'
                 AND NOT (target_type='member' AND CAST(target_id AS INTEGER)=?)
               """,
               [report_id, vault_id, current.created_by]
             ) do
          nil ->
            {:error, "Report not found"}

          [id] ->
            {:ok,
             apply_review(
               id,
               actor_id,
               if(action == "dismiss", do: "dismissed", else: "resolved")
             )}
        end
    end
  end

  def list_global_reports(actor_id, status \\ "open") do
    if not server_owner?(actor_id) do
      {:error, "Owner only"}
    else
      reports =
        SQL.all(
          """
          SELECT r.id,r.vault_id,r.target_type,r.target_id,
            (SELECT u.username FROM users u WHERE r.target_type='member' AND u.id=CAST(r.target_id AS INTEGER)),
            r.reason,r.detail,r.status,r.created_at,r.reviewed_at,v.name,COALESCE(v.visibility,'private'),
            owner.username,r.reporter_user_id,reporter.username
          FROM content_reports r JOIN vaults v ON v.id=r.vault_id
          JOIN users owner ON owner.id=v.created_by JOIN users reporter ON reporter.id=r.reporter_user_id
          WHERE (?='all' OR r.status=?) ORDER BY r.created_at DESC,r.id DESC LIMIT 200
          """,
          [status, status]
        )
        |> Enum.map(fn row ->
          {base, [vault_name, visibility, owner_username, reporter_id, reporter_username]} =
            Enum.split(row, 10)

          Map.merge(map_report(base), %{
            vaultName: vault_name,
            vaultVisibility: visibility,
            vaultOwnerUsername: owner_username,
            reporterUserId: reporter_id,
            reporterUsername: reporter_username
          })
        end)

      {:ok, reports}
    end
  end

  def review_global_report(report_id, actor_id, action) do
    cond do
      not server_owner?(actor_id) ->
        {:error, "Owner only"}

      action not in ["dismiss", "resolve", "unlist"] ->
        {:error, "Action must be dismiss, resolve, or unlist"}

      true ->
        review_global_existing(report_id, actor_id, action)
    end
  end

  defp persist_ban(vault_id, actor_id, target_id, reason) do
    case SQL.one(
           "SELECT id,username,COALESCE(NULLIF(display_name,''),username),COALESCE(avatar_url,'') FROM users WHERE id=?",
           [target_id]
         ) do
      nil ->
        {:error, "User not found"}

      [id, username, display_name, avatar_url] ->
        SQL.transaction(fn ->
          SQL.exec(
            """
            INSERT INTO vault_bans (vault_id,user_id,banned_by,reason) VALUES (?,?,?,?)
            ON CONFLICT(vault_id,user_id) DO UPDATE SET banned_by=excluded.banned_by,
              reason=excluded.reason,created_at=datetime('now')
            """,
            [vault_id, target_id, actor_id, reason]
          )

          SQL.exec("DELETE FROM vault_members WHERE vault_id=? AND user_id=?", [
            vault_id,
            target_id
          ])

          Cascade.Chat.Agents.remove_departed_owners(vault_id)

          SQL.exec(
            """
            UPDATE public_vault_join_requests SET status='rejected',reviewed_by=?,updated_at=datetime('now')
            WHERE vault_id=? AND user_id=? AND status='pending'
            """,
            [actor_id, vault_id, target_id]
          )
        end)

        [[created_at]] =
          SQL.all("SELECT created_at FROM vault_bans WHERE vault_id=? AND user_id=?", [
            vault_id,
            target_id
          ])

        {:ok,
         %{
           userId: id,
           username: username,
           displayName: display_name,
           avatarUrl: avatar_url,
           reason: reason,
           bannedBy: actor_id,
           createdAt: created_at
         }}
    end
  end

  defp validate_and_insert_report(
         requested,
         reporter_id,
         "message" = type,
         target_id,
         reason,
         detail
       ) do
    with {:ok, accountable_vault} <- resolve_message_vault(requested.id, reporter_id, target_id) do
      insert_report(accountable_vault.id, reporter_id, type, target_id, reason, detail)
    end
  end

  defp validate_and_insert_report(requested, reporter_id, type, target_id, reason, detail) do
    case validate_target(requested, reporter_id, type, target_id) do
      :ok -> insert_report(requested.id, reporter_id, type, target_id, reason, detail)
      {:error, _} = error -> error
    end
  end

  defp validate_target(vault, reporter_id, "vault", target_id) do
    cond do
      target_id != vault.id -> {:error, "Report target does not belong to this vault"}
      vault.visibility != "public" -> {:error, "Only a public vault can be reported"}
      reporter_id == vault.created_by -> {:error, "You cannot report your own vault"}
      true -> :ok
    end
  end

  defp validate_target(vault, reporter_id, type, target_id) do
    cond do
      is_nil(VaultMembers.role(vault.id, reporter_id)) ->
        {:error, "Only a member of this vault can report its content"}

      type == "note" and
          is_nil(
            SQL.one(
              """
              SELECT 1 FROM notes WHERE id=? AND vault_id=? AND is_listed=1 AND is_archived=0
                AND trim(content) NOT LIKE 'cascade://chat-channel%'
                AND trim(content_preview) NOT LIKE 'cascade://chat-channel%'
              """,
              [target_id, vault.id]
            )
          ) ->
        {:error, "Report target does not belong to this vault"}

      type == "note" ->
        :ok

      true ->
        validate_member_target(vault.id, reporter_id, target_id)
    end
  end

  defp validate_member_target(vault_id, reporter_id, target_id) do
    case Integer.parse(target_id) do
      {id, ""} when id > 0 ->
        cond do
          id == reporter_id ->
            {:error, "You cannot report yourself"}

          is_nil(VaultMembers.role(vault_id, id)) ->
            {:error, "Report target does not belong to this vault"}

          true ->
            :ok
        end

      _ ->
        {:error, "Invalid user id"}
    end
  end

  defp resolve_message_vault(requested_vault_id, reporter_id, message_id) do
    if is_nil(VaultMembers.role(requested_vault_id, reporter_id)) do
      {:error, "Only a member of this vault can report its content"}
    else
      case SQL.one(
             """
             SELECT m.vault_id,m.channel_id FROM chat_messages m WHERE m.id=? AND (
               (m.vault_id=? AND EXISTS (SELECT 1 FROM notes n WHERE n.id=m.channel_id AND n.vault_id=?))
               OR EXISTS (SELECT 1 FROM chat_channel_links l WHERE l.local_vault_id=?
                 AND l.source_vault_id=m.vault_id AND l.source_channel_id=m.channel_id))
             """,
             [message_id, requested_vault_id, requested_vault_id, requested_vault_id]
           ) do
        nil ->
          {:error, "Report target does not belong to this vault"}

        [source_vault_id, source_channel_id] ->
          accountable_vault = vault(source_vault_id)

          cond do
            DirectMessages.direct_message_channel?(source_channel_id) ->
              {:error, "Direct messages are handled with blocking, not reports"}

            is_nil(accountable_vault) ->
              {:error, "Vault not found"}

            true ->
              {:ok, accountable_vault}
          end
      end
    end
  end

  defp insert_report(vault_id, reporter_id, type, target_id, reason, detail) do
    cond do
      SQL.one(
        "SELECT 1 FROM content_reports WHERE vault_id=? AND target_type=? AND target_id=? AND reporter_user_id=?",
        [vault_id, type, target_id, reporter_id]
      ) ->
        {:error, "You have already reported this"}

      recent_report_count(reporter_id) >= 10 ->
        {:error, "You have sent too many reports recently. Please try again later."}

      true ->
        SQL.exec(
          "INSERT INTO content_reports (vault_id,target_type,target_id,reporter_user_id,reason,detail) VALUES (?,?,?,?,?,?)",
          [vault_id, type, target_id, reporter_id, reason, detail]
        )

        {:ok, report_by_id(SQL.last_insert_id())}
    end
  end

  defp recent_report_count(user_id) do
    [[count]] =
      SQL.all(
        "SELECT COUNT(*) FROM content_reports WHERE reporter_user_id=? AND created_at>datetime('now','-60 minutes')",
        [user_id]
      )

    count
  end

  defp review_global_existing(report_id, actor_id, action) do
    case SQL.one("SELECT id,vault_id FROM content_reports WHERE id=?", [report_id]) do
      nil ->
        {:error, "Report not found"}

      [id, _vault_id] when action != "unlist" ->
        {:ok,
         %{
           report:
             apply_review(
               id,
               actor_id,
               if(action == "dismiss", do: "dismissed", else: "resolved")
             ),
           unlistedVaultId: nil
         }}

      [id, vault_id] ->
        current = vault(vault_id)

        cond do
          is_nil(current) ->
            {:error, "Vault not found"}

          current.visibility != "public" ->
            {:error, "That vault is not publicly listed"}

          true ->
            SQL.transaction(fn ->
              SQL.exec("UPDATE vaults SET visibility='private' WHERE id=?", [vault_id])

              SQL.exec(
                "UPDATE public_vault_join_requests SET status='rejected',reviewed_by=?,updated_at=datetime('now') WHERE vault_id=? AND status='pending'",
                [actor_id, vault_id]
              )

              SQL.exec(
                "UPDATE content_reports SET status='resolved',reviewed_by=?,reviewed_at=datetime('now') WHERE id=?",
                [actor_id, id]
              )
            end)

            {:ok, %{report: report_by_id(id), unlistedVaultId: vault_id}}
        end
    end
  end

  defp apply_review(id, actor_id, status) do
    SQL.exec(
      "UPDATE content_reports SET status=?,reviewed_by=?,reviewed_at=datetime('now') WHERE id=?",
      [status, actor_id, id]
    )

    report_by_id(id)
  end

  defp report_by_id(id) do
    SQL.one(
      """
      SELECT r.id,r.vault_id,r.target_type,r.target_id,
        (SELECT u.username FROM users u WHERE r.target_type='member' AND u.id=CAST(r.target_id AS INTEGER)),
        r.reason,r.detail,r.status,r.created_at,r.reviewed_at FROM content_reports r WHERE r.id=?
      """,
      [id]
    )
    |> map_report()
  end

  defp map_report([
         id,
         vault_id,
         target_type,
         target_id,
         target_username,
         reason,
         detail,
         status,
         created_at,
         reviewed_at
       ]) do
    %{
      id: id,
      vaultId: vault_id,
      targetType: if(target_type in @targets, do: target_type, else: "vault"),
      targetId: target_id,
      targetUsername: target_username,
      reason: if(reason in @reasons, do: reason, else: "other"),
      detail: detail,
      status: if(status in @statuses, do: status, else: "open"),
      createdAt: created_at,
      reviewedAt: reviewed_at
    }
  end

  defp vault(id) do
    case SQL.one(
           "SELECT id,name,created_by,COALESCE(visibility,'private') FROM vaults WHERE id=?",
           [id]
         ) do
      [vault_id, name, created_by, visibility] ->
        %{id: vault_id, name: name, created_by: created_by, visibility: visibility}

      nil ->
        nil
    end
  end
end
