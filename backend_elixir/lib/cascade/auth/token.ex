defmodule Cascade.Auth.Token do
  @moduledoc "HS256 JWTs compatible with the existing jsonwebtoken claim shape."

  alias Cascade.Config

  @user_session_max_age_seconds 7 * 24 * 60 * 60
  @agent_session_max_age_seconds 12 * 60 * 60

  def user_session_max_age_seconds, do: @user_session_max_age_seconds

  def sign_user(user), do: sign(user, "user", @user_session_max_age_seconds)
  def sign_agent(user), do: sign(user, "agent", @agent_session_max_age_seconds)

  def sign_run_agent(user, run_id) do
    source = Cascade.Chat.Delegation.run_source(user.id, run_id)
    sign(user, "agent", @agent_session_max_age_seconds, source)
  end

  def verify(token) when is_binary(token) do
    case verify_with_expiration(token) do
      {:ok, identity, _expires_at} -> {:ok, identity}
      error -> error
    end
  end

  def verify(_token), do: {:error, :invalid_or_expired}

  def verify_with_expiration(token) when is_binary(token) do
    with {:ok, claims} <- Joken.verify(token, signer()),
         :ok <- validate_times(claims),
         {:ok, identity} <- validate_identity_shape(claims) do
      {:ok, identity, claims["exp"]}
    else
      _ -> {:error, :invalid_or_expired}
    end
  end

  def verify_with_expiration(_token), do: {:error, :invalid_or_expired}

  defp sign(user, access, ttl_seconds, source \\ nil) do
    now = System.system_time(:second)

    claims = %{
      "id" => user.id,
      "username" => user.username,
      "authVersion" => Map.get(user, :auth_version, 0),
      "access" => access,
      "agentSource" => source,
      "iat" => now,
      "exp" => now + ttl_seconds
    }

    {:ok, token, _claims} = Joken.encode_and_sign(claims, signer())
    token
  end

  defp validate_times(%{"iat" => issued_at, "exp" => expires_at})
       when is_integer(issued_at) and is_integer(expires_at) do
    now = System.system_time(:second)

    cond do
      issued_at > now + 60 -> {:error, :future_issued_at}
      now - issued_at > @user_session_max_age_seconds -> {:error, :stale_issued_at}
      expires_at <= now -> {:error, :expired}
      true -> :ok
    end
  end

  defp validate_times(_claims), do: {:error, :invalid_times}

  defp validate_identity_shape(%{"id" => id, "username" => username} = claims)
       when is_integer(id) and is_binary(username) do
    auth_version = Map.get(claims, "authVersion", 0)
    access = Map.get(claims, "access", "user")

    if is_integer(auth_version) and access in ["user", "agent"] do
      {:ok,
       %{
         id: id,
         username: username,
         auth_version: auth_version,
         access: access,
         agent_source: claims["agentSource"]
       }}
    else
      {:error, :invalid_identity}
    end
  end

  defp validate_identity_shape(_claims), do: {:error, :invalid_identity}

  defp signer, do: Joken.Signer.create("HS256", Config.jwt_secret!())
end
