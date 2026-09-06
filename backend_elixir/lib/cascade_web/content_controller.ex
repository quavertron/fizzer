defmodule CascadeWeb.ContentController do
  @moduledoc false

  import Plug.Conn

  alias Cascade.Auth.Session
  alias Cascade.Content.{Assets, Privacy, Store, Versions}
  alias CascadeWeb.JSON

  def list_vaults(conn),
    do:
      authenticated(conn, fn conn, auth ->
        JSON.send(conn, 200, %{vaults: Store.list_vaults(auth.user.id)})
      end)

  def create_vault(conn) do
    authenticated(conn, [user_only: true], fn conn, auth ->
      safely(conn, "Could not create vault", fn ->
        JSON.send(conn, 201, %{vault: Store.create_vault(auth.user.id, body(conn))})
      end)
    end)
  end

  def get_vault(conn, id) do
    authenticated(conn, fn conn, auth ->
      case Store.get_vault(id, auth.user.id) do
        nil -> JSON.send(conn, 404, %{error: "Vault not found"})
        vault -> JSON.send(conn, 200, %{vault: vault, role: Store.vault_role(id, auth.user.id)})
      end
    end)
  end

  def rename_vault(conn, id) do
    authenticated(conn, [user_only: true], fn conn, auth ->
      case Store.get_vault(id, auth.user.id) do
        nil ->
          JSON.send(conn, 404, %{error: "Vault not found"})

        _vault ->
          if Store.vault_role(id, auth.user.id) == "owner" do
            safely(conn, "Could not rename vault", fn ->
              vault = Store.rename_vault(id, body_value(conn, "name", ""))
              emit(conn, %{event: "vault:renamed", vaultId: id, name: vault.name})
              JSON.send(conn, 200, %{vault: vault})
            end)
          else
            JSON.send(conn, 403, %{error: "Only the vault owner can rename this vault"})
          end
      end
    end)
  end

  def delete_vault(conn, id) do
    authenticated(conn, fn conn, auth ->
      safely(conn, "Could not delete vault", fn ->
        if auth.access == "agent" do
          run_id = List.first(get_req_header(conn, "x-cascade-run-id"))

          case Cascade.Content.VaultDeletion.delete(
                 auth.user.id,
                 run_id,
                 id,
                 body_value(conn, "expectedName", nil),
                 body_value(conn, "authorityMessageId", nil)
               ) do
            :ok ->
              JSON.send(conn, 200, %{success: true})

            {:error, :denied} ->
              JSON.send(conn, 403, %{
                error:
                  "Vault deletion requires an active owner mission, a current explicit owner deletion instruction, an exact target name, and an inactive target outside the current vault"
              })
          end
        else
          if Store.delete_vault(id, auth.user.id) do
            JSON.send(conn, 200, %{success: true})
          else
            JSON.send(conn, 404, %{error: "Vault not found or you are not its owner"})
          end
        end
      end)
    end)
  end

  def list_folders(conn, vault_id) do
    authenticated(conn, fn conn, auth ->
      with_readable_vault(conn, vault_id, auth.user.id, fn ->
        JSON.send(conn, 200, %{folders: Store.list_folders(vault_id)})
      end)
    end)
  end

  def create_folder(conn, vault_id) do
    authenticated(conn, fn conn, auth ->
      with_writable_vault(
        conn,
        vault_id,
        auth.user.id,
        "Viewer role cannot edit this vault",
        fn ->
          safely(conn, "Could not create folder", fn ->
            JSON.send(conn, 201, %{folder: Store.create_folder(vault_id, body(conn))})
          end)
        end
      )
    end)
  end

  def update_folder(conn, folder_id) do
    authenticated(conn, fn conn, auth ->
      with_writable_folder(conn, folder_id, auth.user.id, fn ->
        safely(
          conn,
          "Could not update folder",
          fn -> JSON.send(conn, 200, %{folder: Store.update_folder(folder_id, body(conn))}) end,
          %{"Folder not found" => 404}
        )
      end)
    end)
  end

  def delete_folder(conn, folder_id) do
    authenticated(conn, [user_only: true], fn conn, auth ->
      with_writable_folder(conn, folder_id, auth.user.id, fn ->
        safely(
          conn,
          "Could not delete folder",
          fn ->
            :ok = Store.delete_folder(folder_id, auth.user.id)
            JSON.send(conn, 200, %{ok: true})
          end,
          %{"Folder not found" => 404}
        )
      end)
    end)
  end

  def list_notes(conn, vault_id) do
    authenticated(conn, fn conn, auth ->
      with_readable_vault(conn, vault_id, auth.user.id, fn ->
        conn = fetch_query_params(conn)

        opts =
          %{}
          |> optional_param(conn.query_params, "folder_id")
          |> optional_boolean(conn.query_params, "is_archived")
          |> optional_param(conn.query_params, "tag")
          |> optional_param(conn.query_params, "title")
          |> optional_param(conn.query_params, "title_contains")

        notes =
          Store.list_notes(vault_id, opts) |> Enum.map(&Privacy.redact_note(&1, agent?(auth)))

        JSON.send(conn, 200, %{notes: notes})
      end)
    end)
  end

  def create_note(conn, vault_id) do
    authenticated(conn, fn conn, auth ->
      with_writable_vault(
        conn,
        vault_id,
        auth.user.id,
        "Viewer role cannot edit this vault",
        fn ->
          safely(conn, "Could not create note", fn ->
            note = Store.create_note(vault_id, auth.user.id, body(conn))
            Versions.create(note.id, note.content, "created")
            Store.reresolve_chat_backlinks(vault_id, note.id, note.title)

            emit(conn, %{
              event: "vault:noteCreated",
              noteId: note.id,
              vaultId: vault_id,
              title: note.title
            })

            JSON.send(conn, 201, %{note: Privacy.redact_note(note, agent?(auth))})
          end)
        end
      )
    end)
  end

  def get_note(conn, note_id) do
    authenticated(conn, fn conn, auth ->
      with_readable_note(conn, note_id, auth.user.id, fn note ->
        JSON.send(conn, 200, %{note: Privacy.redact_note(note, agent?(auth))})
      end)
    end)
  end

  def update_note(conn, note_id) do
    writable_note_action(conn, note_id, "Could not update note", fn conn, auth, existing ->
      proposed = body_value(conn, "content", existing.content) |> to_string()

      content =
        if agent?(auth),
          do: Privacy.restore_blocks(existing.content, proposed),
          else: proposed

      note = Store.update_note(note_id, content, auth.user.id)
      Versions.create(note.id, content, "auto")

      emit(conn, %{
        event: "vault:noteChanged",
        noteId: note.id,
        vaultId: note.vault_id,
        title: note.title
      })

      JSON.send(conn, 200, %{note: Privacy.redact_note(note, agent?(auth))})
    end)
  end

  def rename_note(conn, note_id) do
    writable_note_action(conn, note_id, "Could not rename note", fn conn, auth, _existing ->
      note = Store.rename_note(note_id, body_value(conn, "title", ""), auth.user.id)
      Store.reresolve_chat_backlinks(note.vault_id, note.id, note.title)
      emit(conn, %{event: "vault:noteChanged", noteId: note.id, vaultId: note.vault_id})
      JSON.send(conn, 200, %{note: Privacy.redact_note(note, agent?(auth))})
    end)
  end

  def delete_note(conn, note_id) do
    writable_note_action(conn, note_id, "Could not delete note", fn conn, _auth, existing ->
      Assets.delete_all(note_id)
      Store.delete_note(note_id)

      emit(conn, %{
        event: "vault:noteDeleted",
        noteId: note_id,
        vaultId: existing.vault_id,
        title: existing.title
      })

      JSON.send(conn, 200, %{ok: true})
    end)
  end

  def move_note(conn, note_id) do
    writable_note_action(conn, note_id, "Could not move note", fn conn, auth, _existing ->
      folder_id =
        if Map.has_key?(body(conn), "folder_id"),
          do: blank_nil(body_value(conn, "folder_id", nil)),
          else: nil

      position =
        case body_value(conn, "position", nil) do
          value when is_integer(value) -> value
          _ -> nil
        end

      Store.move_note(note_id, folder_id, position, auth.user.id)
      note = Store.get_note(note_id)
      emit_note_changed(conn, note)

      JSON.send(conn, 200, %{
        note: Privacy.redact_note(note, agent?(auth))
      })
    end)
  end

  def unlist_note(conn, note_id),
    do: mutate_note_toggle(conn, note_id, "Could not unlink note", &Store.unlist_note/2)

  def pin_note(conn, note_id),
    do: mutate_note_toggle(conn, note_id, "Could not pin note", &Store.toggle_pin/2)

  def archive_note(conn, note_id),
    do: mutate_note_toggle(conn, note_id, "Could not archive note", &Store.toggle_archive/2)

  def search(conn, vault_id) do
    authenticated(conn, fn conn, auth ->
      with_readable_vault(conn, vault_id, auth.user.id, fn ->
        conn = fetch_query_params(conn)
        query = conn.query_params |> Map.get("q", "") |> to_string() |> String.trim()

        if query == "" do
          JSON.send(conn, 200, %{results: []})
        else
          scope =
            case conn.query_params
                 |> Map.get("scope", "notes")
                 |> to_string()
                 |> String.downcase() do
              value when value in ["notes", "chat", "all"] -> value
              _ -> "notes"
            end

          results =
            Store.search(vault_id, query, %{
              scope: scope,
              limit: Map.get(conn.query_params, "limit", "40"),
              redact_private: agent?(auth)
            })

          JSON.send(conn, 200, %{results: results})
        end
      end)
    end)
  end

  def backlinks(conn, note_id) do
    authenticated(conn, fn conn, auth ->
      with_readable_note(conn, note_id, auth.user.id, fn _note ->
        conn = fetch_query_params(conn)

        chat_backlinks =
          Store.list_chat_backlinks(note_id, %{
            limit: Map.get(conn.query_params, "limit", "50"),
            offset: Map.get(conn.query_params, "offset", "0"),
            include_deleted: Map.get(conn.query_params, "include_deleted") in ["1", "true"]
          })

        response = %{
          backlinks: Store.get_backlinks(note_id),
          chatBacklinks: chat_backlinks
        }

        JSON.send(
          conn,
          200,
          if(agent?(auth), do: Privacy.sanitize_json(response), else: response)
        )
      end)
    end)
  end

  def list_tags(conn, vault_id) do
    authenticated(conn, fn conn, auth ->
      with_readable_vault(conn, vault_id, auth.user.id, fn ->
        JSON.send(conn, 200, %{tags: Store.list_tags(vault_id)})
      end)
    end)
  end

  def add_tag(conn, note_id) do
    authenticated(conn, fn conn, auth ->
      with_writable_note(conn, note_id, auth.user.id, "Viewer role cannot edit tags", fn note ->
        safely(conn, "Could not add tag", fn ->
          Store.add_tag(
            note_id,
            note.vault_id,
            body_value(conn, "name", ""),
            body_value(conn, "color", nil),
            auth.user.id
          )

          JSON.send(conn, 200, %{note: Privacy.redact_note(Store.get_note(note_id), agent?(auth))})
        end)
      end)
    end)
  end

  def remove_tag(conn, note_id, tag_id) do
    authenticated(conn, fn conn, auth ->
      with_writable_note(conn, note_id, auth.user.id, "Viewer role cannot edit tags", fn _note ->
        Store.remove_tag(note_id, tag_id, auth.user.id)
        JSON.send(conn, 200, %{note: Privacy.redact_note(Store.get_note(note_id), agent?(auth))})
      end)
    end)
  end

  def versions(conn, note_id) do
    authenticated(conn, [user_only: true], fn conn, auth ->
      with_readable_note(conn, note_id, auth.user.id, fn _note ->
        JSON.send(conn, 200, %{versions: Versions.list(note_id)})
      end)
    end)
  end

  def diff(conn, note_id) do
    authenticated(conn, [user_only: true], fn conn, auth ->
      with_readable_note(conn, note_id, auth.user.id, fn note ->
        conn = fetch_query_params(conn)
        from = Map.get(conn.query_params, "from", "") |> to_string()
        to = Map.get(conn.query_params, "to", "") |> to_string()

        cond do
          from != "" and to != "" ->
            case Versions.diff_versions(note_id, from, to) do
              nil -> JSON.send(conn, 404, %{error: "Version not found"})
              text -> JSON.send(conn, 200, %{diff: text})
            end

          true ->
            case Versions.list(note_id) do
              [] ->
                JSON.send(conn, 200, %{
                  diff: Versions.diff_text("", note.content, "empty", note.title)
                })

              [latest | _] ->
                content =
                  case Versions.get(latest.id) do
                    nil -> ""
                    version -> version.content || ""
                  end

                JSON.send(conn, 200, %{
                  diff:
                    Versions.diff_text(
                      content,
                      note.content,
                      "version-#{String.slice(latest.id, 0, 8)}",
                      note.title
                    )
                })
            end
        end
      end)
    end)
  end

  def graph(conn, vault_id) do
    authenticated(conn, [user_only: true], fn conn, auth ->
      with_readable_vault(conn, vault_id, auth.user.id, fn ->
        JSON.send(conn, 200, Store.graph(vault_id))
      end)
    end)
  end

  def upload_asset(conn, note_id) do
    authenticated(conn, [user_only: true], fn conn, auth ->
      safely(
        conn,
        "Could not upload asset",
        fn -> JSON.send(conn, 201, Assets.upload(note_id, auth.user.id, body(conn))) end,
        %{"Note not found" => 404}
      )
    end)
  end

  def serve_asset(conn, note_id, asset_id) do
    if note_id == "agent-avatars" do
      serve_agent_avatar(conn, asset_id)
    else
      serve_private_asset(conn, note_id, asset_id)
    end
  end

  defp serve_agent_avatar(conn, agent_id) do
    case Cascade.Chat.Avatars.resolve(agent_id) do
      nil ->
        JSON.send(conn, 404, %{error: "Not found"})

      path ->
        metadata = Assets.response_metadata(path)

        conn
        |> put_resp_header("x-content-type-options", "nosniff")
        |> put_resp_header("content-type", metadata.content_type)
        |> put_resp_header("cache-control", "public, max-age=31536000, immutable")
        |> send_file(200, path)
    end
  end

  defp serve_private_asset(conn, note_id, asset_id) do
    authenticated(conn, fn conn, auth ->
      with_readable_note(
        conn,
        note_id,
        auth.user.id,
        fn _note ->
          case Assets.resolve_path(note_id, asset_id) do
            nil ->
              JSON.send(conn, 404, %{error: "Not found"})

            path ->
              metadata = Assets.response_metadata(path)

              conn
              |> put_resp_header("x-content-type-options", "nosniff")
              |> put_resp_header("content-security-policy", metadata.csp)
              |> put_resp_header("content-type", metadata.content_type)
              |> put_resp_header("content-disposition", metadata.content_disposition)
              |> put_resp_header("cache-control", metadata.cache_control)
              |> send_file(200, path)
          end
        end,
        "Not found"
      )
    end)
  end

  defp mutate_note_toggle(conn, note_id, fallback, operation) do
    authenticated(conn, fn conn, auth ->
      with_writable_note(
        conn,
        note_id,
        auth.user.id,
        "Viewer role cannot edit this vault",
        fn _existing ->
          safely(conn, fallback, fn ->
            operation.(note_id, auth.user.id)
            note = Store.get_note(note_id)
            emit_note_changed(conn, note)

            JSON.send(conn, 200, %{
              note: Privacy.redact_note(note, agent?(auth))
            })
          end)
        end
      )
    end)
  end

  defp authenticated(conn, callback), do: authenticated(conn, [], callback)

  defp authenticated(conn, options, callback) do
    case Session.authenticate(conn) do
      {:ok, %{access: "agent"} = authentication} ->
        if options[:user_only] do
          JSON.send(conn, 403, %{error: "This operation requires user access"})
        else
          callback.(conn, authentication)
        end

      {:ok, authentication} ->
        callback.(conn, authentication)

      _ ->
        JSON.send(conn, 401, %{error: "Invalid or expired token"})
    end
  end

  @doc "Append one newly generated local-agent caption to a writable note."
  def append_orbit_caption(conn, note_id) do
    authenticated(conn, fn conn, auth ->
      with_writable_note(
        conn,
        note_id,
        auth.user.id,
        "Viewer role cannot edit this vault",
        fn existing ->
          label = caption_value(body_value(conn, "label", "Agent"), 120)
          status = caption_value(body_value(conn, "status", ""), 240)

          if status == "" do
            JSON.send(conn, 422, %{error: "Caption status is required"})
          else
            entry = "- #{label} — #{status}"
            lines = String.split(existing.content, "\n")

            if Enum.member?(lines, entry) do
              JSON.send(conn, 200, %{logged: false})
            else
              content = String.trim_trailing(existing.content) <> "\n" <> entry <> "\n"
              note = Store.update_note(note_id, content, auth.user.id)
              Versions.create(note.id, content, "orbit-caption")
              emit_note_changed(conn, note)
              JSON.send(conn, 200, %{logged: true})
            end
          end
        end
      )
    end)
  end

  defp with_readable_vault(conn, vault_id, user_id, callback) do
    if Store.get_vault(vault_id, user_id),
      do: callback.(),
      else: JSON.send(conn, 404, %{error: "Vault not found"})
  end

  defp with_writable_vault(conn, vault_id, user_id, viewer_error, callback) do
    cond do
      Store.get_writable_vault(vault_id, user_id) -> callback.()
      Store.get_vault(vault_id, user_id) -> JSON.send(conn, 403, %{error: viewer_error})
      true -> JSON.send(conn, 404, %{error: "Vault not found"})
    end
  end

  defp with_readable_note(conn, note_id, user_id, callback, missing_error \\ "Note not found") do
    note = Store.get_note(note_id)

    if note && Store.get_vault(note.vault_id, user_id) do
      callback.(note)
    else
      JSON.send(conn, 404, %{error: missing_error})
    end
  end

  defp with_writable_note(conn, note_id, user_id, viewer_error, callback) do
    note = Store.get_note(note_id)

    cond do
      is_nil(note) -> JSON.send(conn, 404, %{error: "Note not found"})
      Store.get_writable_vault(note.vault_id, user_id) -> callback.(note)
      Store.get_vault(note.vault_id, user_id) -> JSON.send(conn, 403, %{error: viewer_error})
      true -> JSON.send(conn, 404, %{error: "Note not found"})
    end
  end

  defp writable_note_action(conn, note_id, error_message, callback) do
    authenticated(conn, fn conn, auth ->
      with_writable_note(conn, note_id, auth.user.id, "Viewer role cannot edit this vault", fn
        existing ->
          safely(conn, error_message, fn -> callback.(conn, auth, existing) end)
      end)
    end)
  end

  defp with_writable_folder(conn, folder_id, user_id, callback) do
    folder = Store.get_folder(folder_id)

    cond do
      is_nil(folder) ->
        JSON.send(conn, 404, %{error: "Folder not found"})

      Store.get_writable_vault(folder.vault_id, user_id) ->
        callback.()

      Store.get_vault(folder.vault_id, user_id) ->
        JSON.send(conn, 403, %{error: "Viewer role cannot edit this vault"})

      true ->
        JSON.send(conn, 404, %{error: "Folder not found"})
    end
  end

  defp safely(conn, fallback, callback, statuses \\ %{}) do
    callback.()
  rescue
    error ->
      message = if is_exception(error), do: Exception.message(error), else: fallback

      JSON.send(conn, Map.get(statuses, message, 400), %{
        error: if(message == "", do: fallback, else: message)
      })
  end

  defp optional_param(opts, params, key),
    do:
      if(Map.has_key?(params, key),
        do: Map.put(opts, String.to_atom(key), params[key]),
        else: opts
      )

  defp optional_boolean(opts, params, key) do
    case Map.get(params, key) do
      "true" -> Map.put(opts, String.to_atom(key), true)
      "false" -> Map.put(opts, String.to_atom(key), false)
      _ -> opts
    end
  end

  defp body(%Plug.Conn{body_params: %Plug.Conn.Unfetched{}}), do: %{}
  defp body(conn) when is_map(conn.body_params), do: conn.body_params
  defp body(_conn), do: %{}
  defp body_value(conn, key, default), do: Map.get(body(conn), key, default)

  defp caption_value(value, max_length) do
    value
    |> to_string()
    |> String.replace(~r/\s+/, " ")
    |> String.trim()
    |> String.slice(0, max_length)
  end

  defp emit_note_changed(conn, %{id: id, vault_id: vault_id, title: title}),
    do: emit(conn, %{event: "vault:noteChanged", noteId: id, vaultId: vault_id, title: title})

  defp emit_note_changed(_conn, _note), do: :ok

  defp emit(conn, intent) do
    options = Map.get(conn.assigns, :domain_options, [])
    Cascade.Chat.Events.emit(Keyword.get(options, :events), intent) || :ok
  end

  defp blank_nil(value) when value in [nil, ""], do: nil
  defp blank_nil(value), do: value
  defp agent?(%{access: "agent"}), do: true
  defp agent?(_), do: false
end
