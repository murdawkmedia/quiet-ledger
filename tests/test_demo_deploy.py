import contextlib,hashlib,importlib.util,io,json,os,stat,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('ql_team_install',Path(__file__).resolve().parents[1]/'ops/install-shc.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
SOURCE=Path(__file__).resolve().parents[1]
class DemoDeployTests(unittest.TestCase):
 def options(self,**values):
  defaults=dict(revision='1234567890abcdef',base_revision=None,build_reserve_mib=1024,reuse_app_image=False,enable_demo_team=False,enable_hackathon_demo=False);defaults.update(values);return SimpleNamespace(**defaults)
 def test_optional_flags_are_off_by_default(self):
  args=module.argument_parser().parse_args(['--revision','1234567890abcdef','--public-origin','https://demo.example','--backend-host','backend.example','--expected-host','example-host'])
  self.assertFalse(args.enable_demo_team);self.assertFalse(args.reuse_app_image);self.assertIsNone(args.base_revision);self.assertEqual(args.build_reserve_mib,1024)
 def test_build_reserve_and_exact_reviewed_base_preserve_two_gib_floor(self):
  for reserve in [256,512,1024]:
   module.preflight_options(self.options(build_reserve_mib=reserve,base_revision=module.APP_BASE_REVISION),module.FLOOR+reserve*1024**2+1)
   with self.assertRaises(ValueError):module.preflight_options(self.options(build_reserve_mib=reserve),module.FLOOR+reserve*1024**2)
  for value in ['latest','other:tag','abcdef0123456789','c61f97464ef26b03;bad']:
   with self.assertRaises(ValueError):module.preflight_options(self.options(base_revision=value),10*1024**3)
  with self.assertRaises(ValueError):module.preflight_options(self.options(enable_demo_team=True),10*1024**3)
 def test_build_args_never_include_untrusted_environment_or_secret(self):
  with patch.dict(os.environ,{'BASE_IMAGE':'bad:latest','API_KEY':'SYNTHETIC_PRIVATE_VALUE'}):
   args=module.app_build_command(self.options(base_revision=module.APP_BASE_REVISION),Path('/reviewed/release'))
  self.assertEqual(args,['docker','build','--build-arg','BASE_IMAGE=quiet-ledger:'+module.APP_BASE_REVISION,'--tag','quiet-ledger:1234567890abcdef','/reviewed/release']);self.assertNotIn('SYNTHETIC_PRIVATE_VALUE',str(args))
 def test_disabled_feature_preserves_existing_environment_and_does_not_inherit_host_secrets(self):
  before='APP_REVISION=old\nPUBLIC_ORIGIN=https://old.example\nBACKEND_HOST=old.example\nHACKATHON_DEMO_ENABLED=true\nSCOPED_PRIVATE_POINTER=/private/pointer\n# preserved operator note\n'
  with patch.dict(os.environ,{'API_KEY':'SYNTHETIC_PRIVATE_VALUE'}):after=module.render_environment(before,'1234567890abcdef','https://new.example','new.example',False,False)
  self.assertIn('SCOPED_PRIVATE_POINTER=/private/pointer\n',after);self.assertIn('# preserved operator note\n',after);self.assertIn('HACKATHON_DEMO_ENABLED=true\n',after);self.assertNotIn('DEMO_TEAM_ENABLED',after);self.assertNotIn('SYNTHETIC_PRIVATE_VALUE',after)
  enabled=module.render_environment(before,'1234567890abcdef','https://new.example','new.example',True,True);self.assertIn('DEMO_TEAM_ENABLED=true\n',enabled)
  with self.assertRaises(ValueError):module.render_environment('APP_REVISION=x\nAPP_REVISION=y\n','a','https://a.example','a.example',False,False)
 def test_private_feature_paths_and_pinned_images_checked_only_when_enabled(self):
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);secrets=root/'secrets';secrets.mkdir(mode=0o700);state=root/'demo-team';state.mkdir(mode=0o700);(root/'hermes-secrets').mkdir(mode=0o700);tools=root/'tools';tools.mkdir()
   token=secrets/'hermes-worker-token';token.write_text('SYNTHETIC_'+('x'*40));token.chmod(0o600);model=root/'hermes-secrets/model-credential';model.write_text('{"key":"SYNTHETIC_PRIVATE_MODEL_VALUE"}');model.chmod(0o600);binary=tools/'wn-agent';binary.write_bytes(b'fictional pinned executable');binary.chmod(0o755)
   output=json.dumps({'Id':module.HERMES_IMAGE_ID}).encode()
   with patch.object(module,'RUNTIME_UID',os.getuid()),patch.object(module,'WN_BINARY_SHA256',hashlib.sha256(binary.read_bytes()).hexdigest()),patch.object(module.subprocess,'check_output',return_value=output) as inspect:
    module.validate_demo_team(root);inspect.assert_called_once()
    model.chmod(0o644)
    with self.assertRaises(ValueError):module.validate_demo_team(root)
    model.chmod(0o600);binary.write_bytes(b'tampered')
    with self.assertRaises(ValueError):module.validate_demo_team(root)
 def test_pinned_image_mismatch_and_symlink_secret_refuse(self):
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);(root/'secrets').mkdir(mode=0o700);(root/'demo-team').mkdir(mode=0o700);(root/'hermes-secrets').mkdir(mode=0o700);(root/'tools').mkdir();binary=root/'tools/wn-agent';binary.write_bytes(b'fake');binary.chmod(0o755)
   for name in ['secrets/hermes-worker-token','hermes-secrets/model-credential']:(root/name).write_text('SYNTHETIC_'+('x'*40));(root/name).chmod(0o600)
   with patch.object(module,'RUNTIME_UID',os.getuid()),patch.object(module,'WN_BINARY_SHA256',hashlib.sha256(binary.read_bytes()).hexdigest()),patch.object(module.subprocess,'check_output',return_value=json.dumps({'Id':'sha256:wrong'}).encode()):
    with self.assertRaises(ValueError):module.validate_demo_team(root)
   token=root/'secrets/hermes-worker-token';token.unlink();token.symlink_to(root/'hermes-secrets/model-credential')
   with patch.object(module,'RUNTIME_UID',os.getuid()):
    with self.assertRaises(ValueError):module.validate_demo_team(root)
 def test_default_compose_has_no_team_and_override_has_only_exact_secret_mounts(self):
  base=(SOURCE/'ops/compose.hosted.yml').read_text();override=(SOURCE/'ops/compose.demo-hosted.yml').read_text();self.assertNotIn('hermes-demo:',base);self.assertNotIn('DEMO_TEAM_ENABLED',base)
  self.assertIn('image: quiet-ledger-hermes-demo:0.22.5',override);self.assertNotIn('ports:',override);self.assertIn('internal: true',override);self.assertIn('demo_egress:',override)
  worker=override.split('\n  hermes-demo:\n')[1].split('\nnetworks:')[0]
  self.assertEqual(worker.count('source:'),2);self.assertIn('/secrets/hermes-worker-token',worker);self.assertIn('/hermes-secrets/model-credential',worker);self.assertNotIn('/secrets:/',worker);self.assertIn('read_only: true',worker);self.assertIn('mem_limit: 512m',worker);self.assertIn('cpus: 1.0',worker)
 def test_disabled_main_does_not_touch_feature_paths_or_log_preserved_environment(self):
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);(root/'.task-marker').write_text(module.MARKER);release=root/'releases/1234567890abcdef';release.mkdir(parents=True);compose=b'services: {app: {image: quiet-ledger:example}}\n';(release/'compose.yml').write_bytes(compose);(release/'release-manifest.json').write_text(json.dumps({'backend_files':{'compose.yml':hashlib.sha256(compose).hexdigest()}}));(root/'.env').write_text('HACKATHON_DEMO_ENABLED=true\nPRIVATE_POINTER=/private/SYNTHETIC_PRIVATE_VALUE\n');caddy=root/'Caddyfile';caddy.write_bytes(b'sibling.example {}\n');data=root/'data';data.mkdir();record=data/'preserve.bin';record.write_bytes(b'fictional existing record');commands=[];out=io.StringIO();args=SimpleNamespace(**vars(self.options(reuse_app_image=True)),public_origin='https://demo.example',backend_host='backend.example',expected_host='test-host')
   with patch.object(module,'ROOT',root),patch.object(module,'CADDY',caddy),patch.object(module,'argument_parser',return_value=SimpleNamespace(parse_args=lambda:args)),patch.object(module.os,'geteuid',return_value=0),patch.object(module.os,'uname',return_value=SimpleNamespace(nodename='test-host')),patch.object(module.shutil,'disk_usage',return_value=SimpleNamespace(free=10*1024**3)),patch.object(module,'require_local_image',return_value='sha256:'+('a'*64)),patch.object(module,'validate_demo_team') as validate,patch.object(module,'run',side_effect=lambda command,log:commands.append(command)),patch.object(module.subprocess,'check_output',return_value='healthy'),contextlib.redirect_stdout(out):
    module.main()
   validate.assert_not_called();self.assertEqual(record.read_bytes(),b'fictional existing record');self.assertIn('PRIVATE_POINTER=/private/SYNTHETIC_PRIVATE_VALUE',(root/'.env').read_text());self.assertNotIn('SYNTHETIC_PRIVATE_VALUE',out.getvalue());self.assertFalse(any('compose.demo.yml' in str(command) for command in commands));self.assertFalse(any(command[:2]==['docker','build'] for command in commands));self.assertTrue(caddy.read_bytes().startswith(b'sibling.example {}\n'))
if __name__=='__main__':unittest.main()
