use axum::{routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use wreq::{Client, Proxy};
use wreq_util::Emulation;
use std::net::SocketAddr;

#[derive(Deserialize)]
struct FetchTask {
    url: String,
    proxy: String,
}

#[derive(Serialize)]
struct FetchResult {
    status_code: u16,
    html: String,
}

async fn fetch_handler(Json(task): Json<FetchTask>) -> Json<FetchResult> {
    let mut builder = Client::builder().emulation(Emulation::Chrome137);

    // Only attach proxy if one was provided
    if !task.proxy.is_empty() {
        match Proxy::all(&task.proxy) {
            Ok(proxy) => { builder = builder.proxy(proxy); }
            Err(e) => {
                eprintln!("Invalid proxy '{}': {}", task.proxy, e);
                return Json(FetchResult {
                    status_code: 500,
                    html: format!("Invalid proxy: {e}"),
                });
            }
        }
    }

    let client = match builder.build() {
        Ok(c) => c,
        Err(e) => {
            return Json(FetchResult {
                status_code: 500,
                html: format!("Failed to build client: {e}"),
            });
        }
    };

    match client.get(&task.url).send().await {
        Ok(resp) => {
            let status_code = resp.status().as_u16();
            let html = resp.text().await.unwrap_or_default();
            Json(FetchResult { status_code, html })
        }
        Err(e) => Json(FetchResult {
            status_code: 500,
            html: format!("Request failed: {e}"),
        }),
    }
}

#[tokio::main]
async fn main() {
    let app = Router::new().route("/fetch", post(fetch_handler));
    let addr = SocketAddr::from(([0, 0, 0, 0], 3000));
    println!("Wreq-Relay listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
