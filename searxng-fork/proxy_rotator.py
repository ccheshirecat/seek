import itertools
import os


class StaticISPRotator:
    def __init__(self, file_path="/etc/searxng/proxies.txt"):
        proxies = []
        if os.path.exists(file_path):
            with open(file_path) as f:
                proxies = [line.strip() for line in f if line.strip() and not line.startswith("#")]

        self.proxies = proxies if proxies else [""]
        self.pool = itertools.cycle(self.proxies)

    def get_next(self) -> str:
        return next(self.pool)


# Global singleton used by network_relay.py
rotator = StaticISPRotator()
