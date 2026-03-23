FROM searxng/searxng:latest

USER root

# Patch the built-in default settings.yml — it ships with `cache_url: false`
# which fails schema validation before our /etc/searxng/settings.yml is applied.
RUN sed -i 's/cache_url: false/cache_url: ""/g' /usr/local/searxng/searx/settings.yml

# Inject proxy rotator module
COPY proxy_rotator.py /usr/local/searxng/searx/proxy_rotator.py

# Inject relay override — appended to network.py so our definitions win
COPY network_relay.py /tmp/network_relay.py
RUN cat /tmp/network_relay.py >> /usr/local/searxng/searx/network.py \
    && rm /tmp/network_relay.py

# User-facing settings
COPY settings.yml /etc/searxng/settings.yml
RUN chown searxng:searxng /etc/searxng/settings.yml

USER searxng
