import signal
import time
import sys
from os import makedirs
from os.path import exists, dirname
import ConfigParser

import simplejson as json
import zmq
from zmq.eventloop import ioloop
from zmq.eventloop import zmqstream
import requests
from tornado import web
from sockjs.tornado import SockJSRouter, SockJSConnection
from tornado.httpserver import HTTPServer

from assembl.lib.zmqlib import INTERNAL_SOCKET
from assembl.lib.web_token import decode_token, TokenInvalid

# Inspired by socksproxy.

if len(sys.argv) != 2:
    print "usage: python changes_router.py configuration.ini"
    exit()


SECTION = 'app:assembl'

settings = ConfigParser.ConfigParser({'changes.prefix': ''})
settings.read(sys.argv[-1])
CHANGES_SOCKET = settings.get(SECTION, 'changes.socket')
CHANGES_PREFIX = settings.get(SECTION, 'changes.prefix')
TOKEN_SECRET = settings.get(SECTION, 'session.secret')
WEBSERVER_PORT = settings.getint(SECTION, 'changes.websocket.port')
# NOTE: Not sure those are always what we want.
SERVER_HOST = settings.get(SECTION, 'public_hostname')
SERVER_PORT = settings.getint(SECTION, 'public_port')
raven_client = None
try:
    pipeline = settings.get('pipeline:main', 'pipeline').split()
    if 'raven' in pipeline:
        raven_dsn = settings.get('filter:raven', 'dsn')
        from raven import Client
        raven_client = Client(raven_dsn)
except ConfigParser.Error:
    pass

context = zmq.Context.instance()
ioloop.install()
io_loop = ioloop.IOLoop.instance()  # ZMQ loop

if CHANGES_SOCKET.startswith('ipc://'):
    dir = dirname(CHANGES_SOCKET[6:])
    if not exists(dir):
        makedirs(dir)

td = zmq.devices.ThreadDevice(zmq.FORWARDER, zmq.XSUB, zmq.XPUB)
td.bind_in(CHANGES_SOCKET)
td.bind_out(INTERNAL_SOCKET)
td.setsockopt_in(zmq.IDENTITY, 'XSUB')
td.setsockopt_out(zmq.IDENTITY, 'XPUB')
td.start()


class ZMQRouter(SockJSConnection):

    token = None
    discussion = None
    userId = None

    def on_open(self, request):
        self.valid = True

    def on_recv(self, data):
        try:
            data = data[-1]
            if '@private' in data:
                jsondata = json.loads(data)
                jsondata = [x for x in jsondata
                            if x.get('@private', self.userId) == self.userId]
                if not jsondata:
                    return
                data = json.dumps(jsondata)
            self.send(data)
        except Exception:
            if raven_client:
                raven_client.captureException()
            raise

    def do_close(self):
        self.close()
        self.socket = None
        if getattr(self, "loop", None):
            self.loop.stop_on_recv()
            self.loop.close()
            self.loop = None

    def on_message(self, msg):
        try:
            if getattr(self, 'socket', None):
                print "closing old socket"
                self.loop.add_callback(self.do_close)
                return
            if msg.startswith('discussion:') and self.valid:
                self.discussion = msg.split(':', 1)[1]
            if msg.startswith('token:') and self.valid:
                try:
                    self.token = decode_token(
                        msg.split(':', 1)[1], TOKEN_SECRET)
                    self.userId = 'local:AgentProfile/' + str(
                        self.token['userId'])
                except TokenInvalid:
                    pass
            if self.token and self.discussion:
                # Check if token authorizes discussion
                r = requests.get(
                    'http://%s:%d/api/v1/discussion/%s/permissions/read/u/%s' %
                    (SERVER_HOST, SERVER_PORT, self.discussion,
                        self.token['userId']))
                print r.text
                if r.text != 'true':
                    return
                self.socket = context.socket(zmq.SUB)
                self.socket.connect(INTERNAL_SOCKET)
                self.socket.setsockopt(zmq.SUBSCRIBE, '*')
                self.socket.setsockopt(zmq.SUBSCRIBE, str(self.discussion))
                self.loop = zmqstream.ZMQStream(self.socket, io_loop=io_loop)
                self.loop.on_recv(self.on_recv)
                print "connected"
                self.send('[{"@type":"Connection"}]')
        except Exception:
            if raven_client:
                raven_client.captureException()
            raise

    def on_close(self):
        try:
            print "closing"
            self.do_close()
        except Exception:
            if raven_client:
                raven_client.captureException()
            raise


def logger(msg):
    print msg


def log_queue():
    socket = context.socket(zmq.SUB)
    socket.connect(INTERNAL_SOCKET)
    socket.setsockopt(zmq.SUBSCRIBE, '')
    loop = zmqstream.ZMQStream(socket, io_loop=io_loop)
    loop.on_recv(logger)

log_queue()

sockjs_router = SockJSRouter(
    ZMQRouter, prefix=CHANGES_PREFIX, io_loop=io_loop)
routes = sockjs_router.urls
web_app = web.Application(routes, debug=False)


def term(*_ignore):
    web_server.stop()
    io_loop.add_timeout(time.time() + 0.3, io_loop.stop)

signal.signal(signal.SIGTERM, term)

web_server = HTTPServer(web_app)
web_server.listen(WEBSERVER_PORT)
try:
    io_loop.start()
except KeyboardInterrupt:
    term()
except Exception:
    if raven_client:
        raven_client.captureException()
    raise
