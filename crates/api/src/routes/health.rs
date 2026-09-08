use axum::Json;
use axum::extract::State;
use serde::Serialize;

use crate::error::ApiError;
use crate::state::AppState;

#[derive(Serialize)]
pub struct Health {
    status: &'static str,
    db: &'static str,
    version: &'static str,
    server_version: String,
}

/// GET /api/v1/health — proves the process is up AND that it can reach Postgres.
/// The server version is returned because we target PG16 syntax deliberately:
/// the psql client on PATH is newer and will accept syntax the server rejects.
pub async fn health(State(state): State<AppState>) -> Result<Json<Health>, ApiError> {
    let server_version: String = sqlx::query_scalar("SHOW server_version")
        .fetch_one(&state.db)
        .await?;

    Ok(Json(Health {
        status: "ok",
        db: "ok",
        version: env!("CARGO_PKG_VERSION"),
        server_version,
    }))
}
