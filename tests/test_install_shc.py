import importlib.util,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('ql_install',Path(__file__).resolve().parents[1]/'ops/install-shc.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class InstallTests(unittest.TestCase):
 def test_append_preserves_original_bytes(self):
  original=b'other.example {\n reverse_proxy other:1234\n}\n';after=module.managed_config(original,'backend.example.test');self.assertTrue(after.startswith(original));self.assertIn(b'reverse_proxy quiet-ledger:4317',after)
 def test_replace_preserves_siblings(self):
  original=b'first.example {}\n';first=module.managed_config(original,'backend.example.test');after=module.managed_config(first,'new.example.test');self.assertTrue(after.startswith(original));self.assertNotIn(b'backend.example.test {',after);self.assertEqual(after.count(module.BEGIN),1)
 def test_unmanaged_conflict_and_malformed_markers_refuse(self):
  for raw in [b'backend.example.test {\n}\n',module.BEGIN,b'\n'+module.END,module.BEGIN+module.END+module.BEGIN+module.END]:
   with self.assertRaises(ValueError):module.managed_config(raw,'backend.example.test')
 def test_hostname_cannot_inject_config(self):
  for host in ['bad\nexample','*','https://backend.example','backend.example {','example /path']:
   with self.assertRaises(ValueError):module.managed_config(b'',host)
if __name__=='__main__':unittest.main()
