defmodule CascadeWeb.ExtendedContentController do
  @moduledoc false

  import Plug.Conn

  alias Cascade.Auth.Session
  alias Cascade.Chat.Invites
  alias Cascade.Content.{Privacy, Store}
  alias Cascade.{Evolution, Publishing, Scratchpad}
  alias Cascade.Search.QMD
  alias CascadeWeb.JSON

  def wiki_maintenance(conn, vault_id) do
    authenticated(conn, fn conn, auth ->
      case Cascade.WikiMaintenance.status(auth.user.id, vault_id) do
        nil -> JSON.send(conn, 403, %{error: "Vault owner required"})
        status -> JSON.send(conn, 200, status)
      end
    end)
  end

  def configure_wiki_maintenance(conn, vault_id) do
    authenticated(conn, fn conn, auth ->
      case Cascade.WikiMaintenance.configure(auth.user.id, vault_id, conn.body_params) do
        {:ok, status} -> JSON.send(conn, 200, status)
        {:error, error} -> JSON.send(conn, 403, %{error: error})
      end
    end)
  end

  def append_journal(conn, vault_id) do
    scratchpad_action(conn, "Could not append journal entry", 201, :entry, fn user_id ->
      Scratchpad.append_journal_entry(user_id, vault_id, %{
        body: body_value(conn, "body", ""),
        kind: body_value(conn, "kind"),
        agent_key: body_value(conn, "agentKey"),
        run_id: body_value(conn, "runId")
      })
    end)
  end

  def list_journal(conn, vault_id) do
    authenticated(conn, fn conn, auth ->
      safely(conn, "Could not list journal", fn ->
        conn = fetch_query_params(conn)

        entries =
          Scratchpad.list_journal_entries(auth.user.id, vault_id,
            agent_key: conn.query_params["agent"],
            unconsolidated_only: conn.query_params["unconsolidated"] in ["1", "true"],
            since_id: conn.query_params["since"],
            limit: conn.query_params["limit"]
          )

        JSON.send(conn, 200, %{entries: entries})
      end)
    end)
  end

  def consolidate(conn, vault_id) do
    authenticated(conn, fn conn, auth ->
      safely(conn, "Could not mark consolidated", fn ->
        marked =
          Scratchpad.mark_journal_consolidated(auth.user.id, vault_id,
            through_id: body_value(conn, "throughId"),
            agent_key: body_value(conn, "agentKey")
          )

        JSON.send(conn, 200, %{ok: true, marked: marked})
      end)
    end)
  end

  def scratchpad_status(conn, vault_id) do
    authenticated(conn, fn conn, auth ->
      case Store.get_vault(vault_id, auth.user.id) do
        nil ->
          JSON.send(conn, 404, %{error: "Vault not found"})

        vault ->
          conn = fetch_query_params(conn)
          JSON.send(conn, 200, %{status: Scratchpad.status(vault.id, conn.query_params["agent"])})
      end
    end)
  end

  def list_threads(conn, vault_id) do
    authenticated(conn, fn conn, auth ->
      safely(conn, "Could not list open threads", fn ->
        conn = fetch_query_params(conn)

        threads =
          Scratchpad.list_open_threads(auth.user.id, vault_id,
            agent_key: conn.query_params["agent"],
            include_closed: conn.query_params["closed"] in ["1", "true"],
            limit: conn.query_params["limit"]
          )

        JSON.send(conn, 200, %{threads: threads})
      end)
    end)
  end

  def open_thread(conn, vault_id) do
    scratchpad_action(conn, "Could not open thread", 201, :thread, fn user_id ->
      Scratchpad.open_thread(user_id, vault_id, %{
        intent: body_value(conn, "intent", ""),
        blocked_on: body_value(conn, "blockedOn"),
        next_try: body_value(conn, "nextTry"),
        pointer: body_value(conn, "pointer"),
        agent_key: body_value(conn, "agentKey"),
        run_id: body_value(conn, "runId")
      })
    end)
  end

  def close_thread(conn, vault_id, thread_id) do
    scratchpad_action(conn, "Could not close thread", 200, :thread, fn user_id ->
      Scratchpad.close_open_thread(user_id, vault_id,
        thread_id: thread_id,
        agent_key: body_value(conn, "agentKey"),
        reason: body_value(conn, "reason")
      )
    end)
  end

  def create_skill(conn, vault_id) do
    scratchpad_action(conn, "Could not save skill", 201, :note, fn user_id ->
      note =
        Scratchpad.create_skill_note(user_id, vault_id, %{
          title: body_value(conn, "title", ""),
          body: body_value(conn, "body", ""),
          agent_key: body_value(conn, "agentKey")
        })

      %{id: note.id, title: note.title}
    end)
  end

  def list_skills(conn, vault_id) do
    authenticated(conn, fn conn, auth ->
      safely(conn, "Could not list skills", fn ->
        conn = fetch_query_params(conn)

        JSON.send(conn, 200, %{
          skills: Scratchpad.list_skill_notes(auth.user.id, vault_id, conn.query_params["agent"])
        })
      end)
    end)
  end

  def outcome(conn, vault_id) do
    scratchpad_action(conn, "Could not record outcome", 200, :outcome, fn user_id ->
      Scratchpad.record_note_outcome(user_id, vault_id, %{
        note_ref: body_value(conn, "noteRef", ""),
        result: body_value(conn, "result"),
        agent_key: body_value(conn, "agentKey")
      })
    end)
  end

  def promote(conn, vault_id) do
    authenticated(conn, fn conn, auth ->
      safely(conn, "Could not promote note", fn ->
        result =
          Scratchpad.promote_note(auth.user.id, vault_id, %{
            note_ref: body_value(conn, "noteRef", ""),
            agent_key: body_value(conn, "agentKey")
          })

        JSON.send(conn, 200, %{
          note: %{id: result.note.id, title: result.note.title},
          kind: result.kind
        })
      end)
    end)
  end

  def recall(conn, vault_id) do
    authenticated(conn, fn conn, auth ->
      case Store.get_vault(vault_id, auth.user.id) do
        nil ->
          JSON.send(conn, 404, %{error: "Vault not found"})

        vault ->
          conn = fetch_query_params(conn)
          query = conn.query_params |> Map.get("q", "") |> to_string() |> String.trim()

          if query == "" do
            JSON.send(conn, 200, %{hits: []})
          else
            safely(conn, "Recall failed", fn ->
              ranked_ids =
                QMD.search(vault.id, query, scope: "notes", limit: 40)
                |> Enum.filter(&(&1.type == "note"))
                |> Enum.map(& &1.id)

              hits =
                Scratchpad.recall(auth.user.id, vault.id, %{
                  query: query,
                  agent_key: conn.query_params["agent"],
                  limit: conn.query_params["limit"],
                  ranked_ids: ranked_ids
                })

              JSON.send(conn, 200, %{hits: hits})
            end)
          end
      end
    end)
  end

  def backfill_backlinks(conn, vault_id) do
    authenticated(conn, fn conn, auth ->
      case Store.get_vault(vault_id, auth.user.id) do
        nil ->
          JSON.send(conn, 404, %{error: "Vault not found"})

        vault ->
          safely(conn, "Backfill failed", fn ->
            result =
              Evolution.backfill_chat_note_backlinks(vault.id,
                after_rowid: body_value(conn, "afterRowid", 0),
                limit: body_value(conn, "limit", 500)
              )

            JSON.send(conn, 200, result)
          end)
      end
    end)
  end

  def distill(conn, vault_id, channel_id) do
    authenticated(conn, fn conn, auth ->
      safely(conn, "Distill failed", fn ->
        note_ref =
          body_value(conn, "note") || body_value(conn, "noteId") || body_value(conn, "noteRef")

        result =
          Evolution.distill_chat_to_note(auth.user.id, vault_id, channel_id, %{
            mode: body_value(conn, "mode", "create"),
            from_message_id: body_value(conn, "fromMessageId"),
            to_message_id: body_value(conn, "toMessageId"),
            last_n: body_value(conn, "lastN"),
            note_ref: note_ref,
            title: body_value(conn, "title"),
            confirm: body_value(conn, "confirm") == true,
            by: auth.user.username
          })

        response = if agent?(auth), do: Privacy.sanitize_json(result), else: result
        JSON.send(conn, if(result.status == "needs_confirm", do: 202, else: 200), response)
      end)
    end)
  end

  def get_agent_memory(conn, vault_id) do
    authenticated(conn, fn conn, auth ->
      case Store.get_vault(vault_id, auth.user.id) do
        nil ->
          JSON.send(conn, 404, %{error: "Vault not found"})

        vault ->
          safely(conn, "Agent memory failed", fn ->
            conn = fetch_query_params(conn)
            Evolution.ensure_agent_memory_folders(vault.id, auth.user.id)

            injection =
              Evolution.build_agent_memory_injection(vault.id,
                channel_topic: conn.query_params["topic"],
                agent_key: conn.query_params["agent"]
              )

            JSON.send(conn, 200, %{
              enabled: Evolution.agent_memory_enabled?(vault.id),
              injection: injection
            })
          end)
      end
    end)
  end

  def update_agent_memory(conn, vault_id) do
    authenticated(conn, fn conn, auth ->
      cond do
        Store.get_writable_vault(vault_id, auth.user.id) ->
          safely(conn, "Agent memory update failed", fn ->
            if is_boolean(body_value(conn, "enabled")),
              do: Evolution.set_agent_memory_enabled(vault_id, body_value(conn, "enabled"))

            memory = body_value(conn, "remember") || body_value(conn, "body")

            if memory do
              note =
                Evolution.create_agent_memory_note(auth.user.id, vault_id, %{
                  title: body_value(conn, "title"),
                  body: memory,
                  agent_key: body_value(conn, "agent") || body_value(conn, "agentKey"),
                  listed: body_value(conn, "listed") == true
                })

              JSON.send(conn, 201, %{
                enabled: Evolution.agent_memory_enabled?(vault_id),
                note: Privacy.redact_note(note, agent?(auth))
              })
            else
              Evolution.ensure_agent_memory_folders(vault_id, auth.user.id)
              JSON.send(conn, 200, %{enabled: Evolution.agent_memory_enabled?(vault_id)})
            end
          end)

        Store.get_vault(vault_id, auth.user.id) ->
          JSON.send(conn, 403, %{error: "Viewer role cannot edit agent memory"})

        true ->
          JSON.send(conn, 404, %{error: "Vault not found"})
      end
    end)
  end

  def get_publish(conn, note_id) do
    authenticated(conn, fn conn, auth ->
      note = Store.get_note(note_id)

      if note && Store.get_vault(note.vault_id, auth.user.id) do
        case Publishing.get_info(note_id) do
          nil ->
            JSON.send(conn, 200, %{published: false})

          info ->
            JSON.send(conn, 200, %{
              published: true,
              slug: info.slug,
              url: "#{Publishing.public_base_url(conn)}/p/#{info.slug}",
              published_at: info.published_at,
              updated_at: info.updated_at
            })
        end
      else
        JSON.send(conn, 404, %{error: "Note not found"})
      end
    end)
  end

  def publish(conn, note_id) do
    authenticated(conn, fn conn, auth ->
      safely(
        conn,
        "Publish failed",
        fn ->
          snapshot = %{title: body_value(conn, "title"), content: body_value(conn, "content")}
          result = Publishing.publish(note_id, auth.user.id, auth.user.username, snapshot)

          JSON.send(
            conn,
            200,
            Map.put(result, :url, "#{Publishing.public_base_url(conn)}/p/#{result.slug}")
          )
        end,
        %{"Note not found" => 404}
      )
    end)
  end

  def unpublish(conn, note_id) do
    authenticated(conn, fn conn, auth ->
      if Publishing.unpublish(note_id, auth.user.id),
        do: JSON.send(conn, 200, %{success: true}),
        else: JSON.send(conn, 404, %{error: "Note is not published"})
    end)
  end

  def public_page(conn, slug) do
    case Publishing.get_by_slug(slug) do
      nil ->
        send_resp(conn, 404, "Not found")

      published ->
        conn = fetch_query_params(conn)

        conn
        |> put_resp_header("content-type", "text/html; charset=utf-8")
        |> put_resp_header("cache-control", "public, max-age=300")
        |> send_resp(
          200,
          Publishing.render_page(
            published,
            Publishing.public_base_url(conn),
            conn.query_params["embed"] == "1"
          )
        )
    end
  end

  def public_json(conn, slug) do
    case Publishing.get_by_slug(slug) do
      nil ->
        JSON.send(conn, 404, %{error: "Not found"})

      published ->
        conn
        |> put_resp_header("cache-control", "public, max-age=300")
        |> JSON.send(200, Publishing.public_json(published, Publishing.public_base_url(conn)))
    end
  end

  def oembed(conn) do
    conn = fetch_query_params(conn)
    raw_url = conn.query_params["url"] || ""

    cond do
      raw_url == "" ->
        JSON.send(conn, 400, %{error: "url query parameter required"})

      true ->
        base = Publishing.public_base_url(conn)

        case invite_token(raw_url, base) do
          token when is_binary(token) ->
            invite_oembed(conn, token, base)

          nil ->
            public_note_oembed(conn, raw_url, base)
        end
    end
  end

  defp public_note_oembed(conn, raw_url, base) do
    case Publishing.parse_public_url(raw_url, base) do
      nil ->
        JSON.send(conn, 404, %{error: "URL not found"})

      slug ->
        case Publishing.get_by_slug(slug) do
          nil ->
            JSON.send(conn, 404, %{error: "Not found"})

          published ->
            conn
            |> put_resp_header("cache-control", "public, max-age=300")
            |> JSON.send(200, Publishing.oembed(published, base))
        end
    end
  end

  defp invite_oembed(conn, token, base) do
    case Invites.preview(token) do
      {:ok, invite} ->
        owner = if(String.trim(to_string(invite.owner)) == "", do: "Fizzer", else: invite.owner)
        title = "Join ##{invite.title} on Fizzer"

        description = "#{owner} invited you to add this chat to your own vault."

        invite_url = "#{base}/invite/#{URI.encode(token)}"

        payload = %{
          version: "1.0",
          type: "rich",
          provider_name: "Fizzer",
          provider_url: base,
          title: title,
          author_name: owner,
          html:
            ~s(<a href="#{escape_html(invite_url)}" target="_blank" rel="noopener noreferrer">#{escape_html(title)}</a>),
          width: 420,
          height: 96,
          description: description
        }

        conn
        |> put_resp_header("cache-control", "public, max-age=300")
        |> JSON.send(200, payload)

      _ ->
        JSON.send(conn, 404, %{error: "Invite not found"})
    end
  end

  defp invite_token(raw_url, base) do
    with %URI{scheme: scheme, host: host, port: port, path: path} <- URI.parse(raw_url),
         %URI{scheme: ^scheme, host: ^host, port: ^port} <- URI.parse(base),
         ["", "invite", encoded] <- String.split(path || "", "/"),
         {:ok, token} <- URI.decode(encoded) |> then(&{:ok, &1}) do
      token
    else
      _ -> nil
    end
  rescue
    _ -> nil
  end

  defp escape_html(value) do
    value
    |> to_string()
    |> String.replace("&", "&amp;")
    |> String.replace("<", "&lt;")
    |> String.replace(">", "&gt;")
    |> String.replace("\"", "&quot;")
  end

  def search(conn, vault_id) do
    authenticated(conn, fn conn, auth ->
      case Store.get_vault(vault_id, auth.user.id) do
        nil ->
          JSON.send(conn, 404, %{error: "Vault not found"})

        vault ->
          conn = fetch_query_params(conn)
          query = conn.query_params |> Map.get("q", "") |> to_string() |> String.trim()

          if query == "" do
            JSON.send(conn, 200, %{results: []})
          else
            safely(conn, "Search failed", fn ->
              scope =
                if conn.query_params["scope"] in ["notes", "chat", "all"],
                  do: conn.query_params["scope"],
                  else: "notes"

              results =
                QMD.search(vault.id, query,
                  scope: scope,
                  limit: conn.query_params["limit"] || 40,
                  redact_private: agent?(auth)
                )

              JSON.send(conn, 200, %{results: results})
            end)
          end
      end
    end)
  end

  defp scratchpad_action(conn, error_message, status, key, fun) do
    authenticated(conn, fn conn, auth ->
      safely(conn, error_message, fn ->
        JSON.send(conn, status, %{key => fun.(auth.user.id)})
      end)
    end)
  end

  defp authenticated(conn, callback) do
    case Session.authenticate(conn) do
      {:ok, authentication} -> callback.(conn, authentication)
      _ -> JSON.send(conn, 401, %{error: "Invalid or expired token"})
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

  defp body(conn), do: if(is_map(conn.body_params), do: conn.body_params, else: %{})
  defp body_value(conn, key, default \\ nil), do: Map.get(body(conn), key, default)
  defp agent?(auth), do: auth.access == "agent"
end
