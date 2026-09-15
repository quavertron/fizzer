#[tokio::main]
async fn main() -> color_eyre::Result<()> {
    fizzer::run().await
}
