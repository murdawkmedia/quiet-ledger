import importlib.util
from pathlib import Path
import socket
import socketserver
import http.server
import json
import threading
import tempfile
import unittest
import contextlib
import hashlib
import io
from types import SimpleNamespace
from unittest.mock import patch

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

    def test_codex_client_is_explicit_and_requires_the_codex_accountant(self):
        self.assertFalse(self.args().enable_codex_client)
        for extra in [[], ['--enable-hackathon-demo'], ['--enable-hackathon-demo', '--enable-demo-team']]:
            with self.assertRaises(ValueError):
                module.preflight_options(self.args('--enable-codex-client', *extra), 8 * 1024 ** 3)
        module.preflight_options(self.args('--enable-codex-client', '--enable-codex-accountant',
            '--enable-hackathon-demo', '--enable-demo-team'), 8 * 1024 ** 3)

    def test_an_existing_codex_client_cannot_be_silently_dropped_on_redeploy(self):
        before = 'APP_REVISION=old\nDEMO_ACCOUNTANT_RUNTIME=codex\nDEMO_CLIENT_RUNTIME=codex\nCUSTOM=preserved\n'
        with self.assertRaises(ValueError):
            module.render_environment(before, '1' * 16, 'https://demo.example', 'backend.example', True, True, True)
        with self.assertRaises(ValueError):
            module.render_environment('', '1' * 16, 'https://demo.example', 'backend.example', True, True, False, True)
        after = module.render_environment(before, '1' * 16, 'https://demo.example', 'backend.example', True, True, True, True)
        self.assertIn('DEMO_CLIENT_RUNTIME=codex\n', after)
        self.assertIn('CUSTOM=preserved\n', after)
        self.assertEqual(after.count('DEMO_CLIENT_RUNTIME='), 1)
        accountant_only = module.render_environment('', '1' * 16, 'https://demo.example', 'backend.example', True, True, True)
        self.assertNotIn('DEMO_CLIENT_RUNTIME=', accountant_only)

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
                with self.assertRaises(ValueError):
                    module.validate_codex_accountant(root, client=True)
                health['roles'] = ['client', 'accountant']
                module.validate_codex_accountant(root, client=True)
                for roles in [None, [], ['accountant'], ['client'], ['client', 'accountant', 'other'], ['client', 'client', 'accountant']]:
                    health['roles'] = roles
                    with self.assertRaises(ValueError):
                        module.validate_codex_accountant(root, client=True)
                health['roles'] = ['client', 'accountant']
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

    def test_hosted_codex_override_does_not_migrate_the_client_by_default(self):
        compose = (Path(__file__).resolve().parents[1] / 'ops/compose.codex-hosted.yml').read_text()
        self.assertIn('DEMO_CLIENT_RUNTIME: ${DEMO_CLIENT_RUNTIME:-hermes}', compose)
        self.assertNotIn('ports:', compose)

    def _install_with_ambient_client(self, client, ambient):
        with tempfile.TemporaryDirectory(prefix='ql-codex-client-install-') as temp:
            root = Path(temp)
            (root / '.task-marker').write_text(module.MARKER)
            release = root / 'releases' / ('1' * 16)
            release.mkdir(parents=True)
            files = {'compose.yml': b'services: {}\n', 'compose-demo.yml': b'services: {}\n', 'compose-codex.yml': b'services: {}\n'}
            for name, value in files.items():
                (release / name).write_bytes(value)
            (release / 'release-manifest.json').write_text(json.dumps({'backend_files': {name: hashlib.sha256(value).hexdigest() for name, value in files.items()}}))
            (root / '.env').write_text('DEMO_ACCOUNTANT_RUNTIME=codex\nCUSTOM=preserved\n')
            caddy = root / 'Caddyfile'
            caddy.write_bytes(b'sibling.example {}\n')
            record = root / 'existing-record'
            record.write_text('fictional retained record')
            flags = ['--enable-codex-accountant', '--enable-hackathon-demo', '--enable-demo-team', '--reuse-app-image']
            args = self.args(*(['--enable-codex-client'] if client else []), *flags)
            commands = []
            output = io.StringIO()
            with patch.object(module, 'ROOT', root), patch.object(module, 'CADDY', caddy), \
                    patch.object(module, 'argument_parser', return_value=SimpleNamespace(parse_args=lambda: args)), \
                    patch.object(module.os, 'geteuid', return_value=0), \
                    patch.object(module.os, 'uname', return_value=SimpleNamespace(nodename='fixture')), \
                    patch.object(module.shutil, 'disk_usage', return_value=SimpleNamespace(free=8 * 1024 ** 3)), \
                    patch.object(module, 'require_local_image', return_value='sha256:' + 'a' * 64), \
                    patch.object(module, 'validate_demo_team'), patch.object(module, 'validate_codex_accountant') as health, \
                    patch.dict(module.os.environ, {'DEMO_CLIENT_RUNTIME': ambient}), \
                    patch.object(module, 'run', side_effect=lambda command, log, **kwargs: commands.append((command, kwargs))), \
                    patch.object(module.subprocess, 'check_output', return_value='healthy'), contextlib.redirect_stdout(output):
                module.main()
            health.assert_called_once_with(root, client=client)
            if client:
                self.assertIn('DEMO_CLIENT_RUNTIME=codex\n', (root / '.env').read_text())
            else:
                self.assertNotIn('DEMO_CLIENT_RUNTIME=codex\n', (root / '.env').read_text())
            self.assertIn('CUSTOM=preserved\n', (root / '.env').read_text())
            self.assertEqual(record.read_text(), 'fictional retained record')
            self.assertTrue(caddy.read_bytes().startswith(b'sibling.example {}\n'))
            compose = next(kwargs for command, kwargs in commands if command[:2] == ['docker', 'compose'])
            self.assertEqual(compose.get('env', {}).get('DEMO_CLIENT_RUNTIME'), 'codex' if client else 'hermes')
            self.assertEqual(json.loads((root / 'deployment.json').read_text())['codex_client_enabled'], client)

    def test_client_opt_in_cannot_be_downgraded_by_the_callers_environment(self):
        self._install_with_ambient_client(True, 'hermes')

    def test_the_callers_environment_cannot_enable_a_codex_client_without_opt_in(self):
        self._install_with_ambient_client(False, 'codex')


if __name__ == '__main__':
    unittest.main()
