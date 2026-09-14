defmodule Cascade.Accounts.Accounts do
  @moduledoc "Account lifecycle operations over the shared Node-compatible users table."

  alias Cascade.Accounts.{Invites, JWT, SQL}
  alias Cascade.Auth.{Accounts, Password, Token}

  @username ~r/^[a-z0-9_]{3,32}$/

  def register(input, options \\ []) do
    username = input |> value("username", "") |> to_string() |> String.trim() |> String.downcase()
    password = input |> value("password", "") |> to_string()

    cond do
      not Regex.match?(@username, username) ->
        {:error, 400, "Username must be 3-32 lowercase letters, numbers, or underscores"}

      true ->
        with :ok <- Password.validate(password),
             {:ok, hash} <- Password.hash(password) do
          insert_registered(username, hash, value(input, "inviteToken"), options)
        else
          {:error, message} -> {:error, 400, message}
        end
    end
  end

  def change_password(user_id, current_password, new_password) do
    with :ok <- Password.validate(to_string(new_password)),
         {:ok, user} <- Accounts.fetch_by_id(user_id),
         true <- Password.verify_login(to_string(current_password), user.password_hash),
         {:ok, password_hash} <- Password.hash(to_string(new_password)) do
      changed =
        SQL.changes(
          """
          UPDATE users SET password_hash = ?, auth_version = auth_version + 1
          WHERE id = ? AND password_hash = ?
          """,
          [password_hash, user.id, user.password_hash]
        )

      if changed == 1 do
        {:ok, updated} = Accounts.fetch_by_id(user.id)
        {:ok, updated, Token.sign_user(updated)}
      else
        {:error, 409, "Password changed in another session; please try again"}
      end
    else
      {:error, message} when is_binary(message) -> {:error, 400, message}
      :error -> {:error, 401, "Current password is incorrect"}
      false -> {:error, 401, "Current password is incorrect"}
    end
  end

  def update_profile(user_id, display_name_raw, avatar_url_raw) do
    display_name = display_name_raw |> to_string() |> String.trim()
    avatar_url = avatar_url_raw |> to_string() |> String.trim()

    cond do
      String.length(display_name) < 1 or String.length(display_name) > 48 or
          Regex.match?(~r/[\x00-\x1f\x7f]/u, display_name) ->
        {:error, 400, "Display name must be 1-48 characters without control characters"}

      String.length(avatar_url) > 2_800_000 ->
        {:error, 400, "Profile picture must be smaller than 2 MB"}

      avatar_url != "" and
          not Regex.match?(
            ~r/^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+\/=]+$/i,
            avatar_url
          ) ->
        {:error, 400, "Profile picture must be a PNG, JPEG, WebP, or GIF image"}

      true ->
        SQL.exec("UPDATE users SET display_name = ?, avatar_url = ? WHERE id = ?", [
          display_name,
          avatar_url,
          user_id
        ])

        {:ok, user} = Accounts.fetch_by_id(user_id)
        {:ok, Accounts.public_user(user)}
    end
  end

  def issue_reset(actor_user_id, username_raw) do
    if not Accounts.owner?(actor_user_id) do
      {:error, 403, "Only the server owner can issue password resets"}
    else
      username = username_raw |> to_string() |> String.trim() |> String.downcase()

      case Accounts.fetch_by_username(username) do
        {:ok, target} ->
          token =
            JWT.sign(
              %{"type" => "pw-reset", "userId" => target.id},
              60 * 60,
              Cascade.Config.jwt_secret!() <> target.password_hash
            )

          {:ok, %{token: token, username: target.username, expiresInMinutes: 60}}

        :error ->
          {:error, 404, "No account with that username"}
      end
    end
  end

  def redeem_reset(token_raw, new_password) do
    token = token_raw |> to_string() |> String.trim()

    with :ok <- Password.validate(to_string(new_password)),
         {:ok, %{"type" => "pw-reset", "userId" => user_id}} when is_integer(user_id) <-
           JWT.peek(token),
         {:ok, user} <- Accounts.fetch_by_id(user_id),
         {:ok, _claims} <- JWT.verify(token, Cascade.Config.jwt_secret!() <> user.password_hash),
         {:ok, hash} <- Password.hash(to_string(new_password)) do
      changed =
        SQL.changes(
          "UPDATE users SET password_hash = ?, auth_version = auth_version + 1 WHERE id = ? AND password_hash = ?",
          [hash, user.id, user.password_hash]
        )

      if changed == 1 do
        {:ok, updated} = Accounts.fetch_by_id(user.id)
        {:ok, updated, Token.sign_user(updated)}
      else
        {:error, 400, "This reset link has already been used"}
      end
    else
      {:error, message} when is_binary(message) -> {:error, 400, message}
      :error -> {:error, 400, "This reset link is invalid"}
      {:error, :invalid} -> {:error, 400, "This reset link is invalid or has expired"}
      _ -> {:error, 400, "This reset link is invalid"}
    end
  end

  def agent_token(user), do: Token.sign_agent(user)

  def list_users(actor_user_id) do
    if Accounts.owner?(actor_user_id) do
      users =
        SQL.all(
          "SELECT id, username, display_name, avatar_url, created_at FROM users ORDER BY id ASC"
        )
        |> Enum.map(fn [id, username, display_name, avatar_url, created_at] ->
          %{
            id: id,
            username: username,
            displayName: blank(display_name, username),
            avatarUrl: avatar_url || "",
            created_at: created_at
          }
        end)

      {:ok, users}
    else
      {:error, 403, "Owner only"}
    end
  end

  defp insert_registered(username, password_hash, invite_token, options) do
    require_invite =
      Keyword.get(options, :require_invite, Cascade.Config.require_invite_registration?())

    try do
      user =
        SQL.transaction(fn ->
          [[count]] = SQL.all("SELECT COUNT(*) FROM users")

          invite_hash =
            if require_invite and count > 0,
              do: Invites.valid_registration_hash(invite_token),
              else: nil

          if require_invite and count > 0 and is_nil(invite_hash), do: throw(:invite_required)

          SQL.exec("INSERT INTO users (username, password_hash) VALUES (?, ?)", [
            username,
            password_hash
          ])

          id = SQL.last_insert_id()

          if invite_hash,
            do:
              SQL.exec(
                "INSERT INTO registration_invites_used (token_hash, user_id) VALUES (?, ?)",
                [invite_hash, id]
              )

          %{id: id, username: username, display_name: "", avatar_url: "", auth_version: 0}
        end)

      {:ok, user, Token.sign_user(user)}
    rescue
      _error in Exqlite.Error -> {:error, 409, "Username is already taken"}
      _error in Ecto.ConstraintError -> {:error, 409, "Username is already taken"}
    catch
      :invite_required ->
        {:error, 403, "A valid unused invitation is required to create an account"}
    end
  end

  defp value(map, key, default \\ nil),
    do: Map.get(map, key, Map.get(map, String.to_atom(key), default))

  defp blank(value, fallback) when value in [nil, ""], do: fallback
  defp blank(value, _fallback), do: value
end
