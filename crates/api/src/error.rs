use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;

/// Every failure carries a STABLE machine-readable code the React app switches
/// on. Message text is for humans and may change; `code` may not.
#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("database unavailable")]
    Database(#[from] sqlx::Error),
}

#[derive(Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
}

impl ApiError {
    fn code(&self) -> &'static str {
        match self {
            ApiError::Database(_) => "DATABASE_UNAVAILABLE",
        }
    }

    fn status(&self) -> StatusCode {
        match self {
            ApiError::Database(_) => StatusCode::SERVICE_UNAVAILABLE,
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self.status();
        let body = ErrorBody {
            code: self.code(),
            message: self.to_string(),
        };
        tracing::error!(code = body.code, error = %self, "request failed");
        (status, axum::Json(body)).into_response()
    }
}
