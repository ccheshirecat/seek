FROM rust:1.85-slim AS builder

# wreq links against BoringSSL, which requires these build tools
RUN apt-get update && apt-get install -y \
    build-essential cmake perl pkg-config libclang-dev musl-tools golang-go \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY Cargo.toml ./
COPY src ./src

RUN cargo build --release

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/wreq-relay /usr/local/bin/wreq-relay

EXPOSE 3000
CMD ["wreq-relay"]
