defmodule CascadeWeb.HtmlPreview do
  @moduledoc "Authenticated guard document. Uploaded bytes never become same-origin active HTML."
  import Plug.Conn
  @guard_path Path.expand("../../priv/html-preview-guard.js", __DIR__)
  @external_resource @guard_path
  @guard File.read!(@guard_path)

  def send(conn, html) do
    conn
    |> delete_resp_header("x-frame-options")
    |> put_resp_header(
      "content-security-policy",
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; frame-src 'none'; connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts allow-forms"
    )
    |> put_resp_header(
      "permissions-policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=()"
    )
    |> put_resp_header("x-dns-prefetch-control", "off")
    |> put_resp_header("cache-control", "no-store")
    |> put_resp_header("referrer-policy", "no-referrer")
    |> put_resp_content_type("text/html")
    |> send_resp(200, document(html))
  end

  def document(html) do
    """
    <!doctype html><meta charset="utf-8"><title>Fizzer HTML preview</title>
    <style>html,body{margin:0;height:100%;font:13px system-ui;background:#fff;color:#222}body{display:flex;flex-direction:column}p{padding:8px;margin:0;background:#eee}iframe{border:0;width:100%;flex:1}</style>
    <p id="notice">Isolated preview: no network, storage, popups or downloads. Inline scripts may use DOM APIs, but HTML injection (innerHTML, document.write), eval, nested frames and external libraries are disabled.</p>
    <iframe id="preview" title="HTML artifact" sandbox="allow-scripts allow-forms" allow="camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'"></iframe>
    <script id="artifact" type="application/octet-stream">#{Base.encode64(html)}</script>
    <script>#{@guard}</script>
    """
  end
end
