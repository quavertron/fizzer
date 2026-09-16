defmodule CascadeWeb.ContentHTTP do
  @moduledoc false

  alias Cascade.Auth.Session
  alias Cascade.Content.Store
  alias CascadeWeb.JSON

  # Content capabilities are action-local; Auth's route allowlist is narrower.
  def authenticated(conn, options \\ [], callback) do
    case Session.authenticate(conn) do
      {:ok, auth} ->
        if options[:user_only] && agent?(auth),
          do: JSON.send(conn, 403, %{error: "This operation requires user access"}),
          else: respond(conn, options, fn -> callback.(conn, auth) end)

      _ ->
        JSON.send(conn, 401, %{error: "Invalid or expired token"})
    end
  end

  def content(conn, resource, options \\ [], callback) do
    authenticated(conn, Keyword.take(options, [:user_only]), fn conn, auth ->
      {item, allowed, missing} = resource(resource, auth.user.id, options[:write])

      cond do
        is_nil(item) ->
          JSON.send(conn, 404, %{error: options[:missing] || missing})

        allowed ->
          respond(conn, options, fn -> callback.(conn, auth, item) end)

        true ->
          JSON.send(conn, 403, %{error: options[:viewer] || "Viewer role cannot edit this vault"})
      end
    end)
  end

  defp resource({:vault, id}, user_id, write) do
    {vault, allowed} = vault_access(id, user_id, write)
    {vault, allowed, "Vault not found"}
  end

  defp resource({kind, id}, user_id, write) do
    item = if kind == :note, do: Store.get_note(id), else: Store.get_folder(id)

    {vault, allowed} =
      if item, do: vault_access(item.vault_id, user_id, write), else: {nil, false}

    {vault && item, allowed, if(kind == :note, do: "Note not found", else: "Folder not found")}
  end

  defp vault_access(id, user_id, write) do
    if vault = write && Store.get_writable_vault(id, user_id),
      do: {vault, true},
      else: {Store.get_vault(id, user_id), !write}
  end

  defp respond(conn, options, callback) do
    if options[:error],
      do: safely(conn, options[:error], callback),
      else: callback.()
  end

  def safely(conn, fallback, callback, statuses \\ %{}) do
    callback.()
  rescue
    error ->
      message = Exception.message(error)

      JSON.send(conn, Map.get(statuses, message, 400), %{
        error: if(message == "", do: fallback, else: message)
      })
  end

  def body(%Plug.Conn{body_params: %Plug.Conn.Unfetched{}}), do: %{}
  def body(conn) when is_map(conn.body_params), do: conn.body_params
  def body(_conn), do: %{}
  def body_value(conn, key, default \\ nil), do: Map.get(body(conn), key, default)
  def agent?(%{access: "agent"}), do: true
  def agent?(_), do: false
end
