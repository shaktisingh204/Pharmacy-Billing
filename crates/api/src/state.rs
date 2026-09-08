use sqlx::postgres::PgPoolOptions;
use std::time::Duration;

#[derive(Clone)]
pub struct AppState {
    pub db: sqlx::PgPool,
}

impl AppState {
    pub async fn connect(database_url: &str) -> anyhow::Result<Self> {
        // Tuned for a counter, not a web farm: a handful of terminals, and an
        // acquire timeout short enough that a stalled pool surfaces as an error
        // rather than a frozen till.
        let db = PgPoolOptions::new()
            .max_connections(16)
            .min_connections(4)
            .acquire_timeout(Duration::from_secs(4))
            .idle_timeout(Duration::from_secs(300))
            .connect(database_url)
            .await?;
        Ok(Self { db })
    }
}
