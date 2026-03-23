FROM searxng/searxng:latest

USER root

# Inject proxy rotator module
COPY proxy_rotator.py /usr/local/searxng/searx/proxy_rotator.py

# Inject relay override — appended to network.py so our definitions win
COPY network_relay.py /tmp/network_relay.py
RUN cat /tmp/network_relay.py >> /usr/local/searxng/searx/network.py \
    && rm /tmp/network_relay.py

# Default settings — must be owned by searxng user
COPY settings.yml /etc/searxng/settings.yml
RUN chown searxng:searxng /etc/searxng/settings.yml

USER searxng
