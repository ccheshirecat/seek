FROM rust:1.82-slim AS builder

WORKDIR /app
COPY Cargo.toml ./
COPY src ./src

# Cache dependencies layer
RUN cargo build --release

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/wreq-relay /usr/local/bin/wreq-relay

EXPOSE 3000
CMD ["wreq-relay"]
