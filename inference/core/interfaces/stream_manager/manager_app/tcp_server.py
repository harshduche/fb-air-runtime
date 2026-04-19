import socket
from socketserver import BaseRequestHandler, TCPServer, ThreadingMixIn
from typing import Any, Optional, Tuple, Type


class RoboflowTCPServer(ThreadingMixIn, TCPServer):
    """TCP server for the InferencePipeline Manager.

    Historical context (2026-04): this class used to inherit from plain
    ``TCPServer``, which handles one request at a time in the single
    accept thread. A slow command handler — e.g. an ``initialise`` that
    loads SAM3 (tens of seconds) — would block every subsequent
    command from the FastAPI layer because each `handle()` ran to
    completion inline with `accept()`. Clients saw this as
    ``Could not establish communication with InferencePipeline Manager``
    and ``Initialise timed out after 45s`` since their fetches queued up
    in the TCP accept backlog instead of being processed.

    Mixing in ``ThreadingMixIn`` spawns one worker thread per accepted
    connection, so slow handlers no longer starve the others. This pairs
    with the ``get_response_ignoring_thrash`` timeout patch in
    ``app.py`` — that one guarantees the handler itself returns in
    bounded time, this one guarantees one slow handler doesn't freeze
    the rest of the manager. ``daemon_threads = True`` makes sure those
    worker threads don't outlive a manager shutdown and leak file
    descriptors.
    """

    daemon_threads = True
    # Block on shutdown until handlers finish — prevents sending
    # half-formed responses during an ``execute_termination`` signal.
    block_on_close = False

    def __init__(
        self,
        server_address: Tuple[str, int],
        handler_class: Type[BaseRequestHandler],
        socket_operations_timeout: Optional[float] = None,
    ):
        TCPServer.__init__(self, server_address, handler_class)
        self._socket_operations_timeout = socket_operations_timeout

    def get_request(self) -> Tuple[socket.socket, Any]:
        connection, address = self.socket.accept()
        connection.settimeout(self._socket_operations_timeout)
        return connection, address
