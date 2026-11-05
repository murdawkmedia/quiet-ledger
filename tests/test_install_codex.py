import importlib.util
from pathlib import Path
import socket
import socketserver
import http.server
import json
import threading
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('ql_codex_install', Path(__file__).resolve().parents[1] / 'ops/install-shc.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CodexInstallTests(unittest.TestCase):
    def args(self, *extra):
        return module.argument_parser().parse_args([
            '--revision', '1' * 16, '--public-origin', 'https://demo.example',
            '--backend-host', 'backend.example', '--expected-host', 'fixture', *extra])

    def test_codex_requires_the_registered_fictional_team(self):
        for extra in [[], ['--enable-hackathon-demo']]:
            with self.assertRaises(ValueError):
                module.preflight_options(self.args('--enable-codex-accountant', *extra), 8 * 1024 ** 3)
        module.preflight_options(self.args('--enable-codex-accountant', '--enable-hackathon-demo', '--enable-demo-team'), 8 * 1024 ** 3)

    def test_an_existing_codex_selection_cannot_silently_return_to_the_default(self):
        before = 'APP_REVISION=old\nDEMO_ACCOUNTANT_RUNTIME=codex\nCUSTOM=preserved\n'
        with self.assertRaises(ValueError):
            module.render_environment(before, '1' * 16, 'https://demo.example', 'backend.example', True, True)
        after = module.render_environment(before, '1' * 16, 'https://demo.example', 'backend.example', True, True, True)
        self.assertIn('DEMO_ACCOUNTANT_RUNTIME=codex\n', after)
        self.assertIn('CUSTOM=preserved\n', after)
        self.assertEqual(after.count('DEMO_ACCOUNTANT_RUNTIME='), 1)

    def test_socket_is_private_owned_and_not_a_regular_file_or_link(self):
        with tempfile.TemporaryDirectory(prefix='ql-codex-install-') as temp:
            root = Path(temp)
            directory = root / 'codex-bridge'
            directory.mkdir(mode=0o700)
            path = directory / 'codex.sock'
            path.write_text('not a socket')
            path.chmod(0o600)
            with self.assertRaises(ValueError):
                module.codex_socket_path(root)
            path.unlink()
            server = socket.socket(socket.AF_UNIX)
            try:
                server.bind(str(path))
                path.chmod(0o600)
                self.assertEqual(module.codex_socket_path(root), path)
                path.chmod(0o666)
                with self.assertRaises(ValueError):
                    module.codex_socket_path(root)
            finally:
                server.close()

    def test_installer_checks_the_reachable_model_and_effort(self):
        with tempfile.TemporaryDirectory(prefix='ql-codex-health-') as temp:
            root = Path(temp)
            directory = root / 'codex-bridge'
            directory.mkdir(mode=0o700)
            path = directory / 'codex.sock'
            health = {'runtime': 'codex', 'ready': True, 'model': 'gpt-6-luna', 'reasoningEffort': 'max'}
            class Handler(http.server.BaseHTTPRequestHandler):
                def log_message(self, *args):
                    pass
                def do_GET(self):
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(json.dumps(health).encode())
            server = socketserver.UnixStreamServer(str(path), Handler)
            path.chmod(0o600)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                module.validate_codex_accountant(root)
                for field, value in [('model', 'other'), ('reasoningEffort', 'low'), ('runtime', 'hermes'), ('ready', False)]:
                    original = health[field]
                    health[field] = value
                    with self.assertRaises(ValueError):
                        module.validate_codex_accountant(root)
                    health[field] = original
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)


if __name__ == '__main__':
    unittest.main()
