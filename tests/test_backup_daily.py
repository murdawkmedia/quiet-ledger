import importlib.util,os,tempfile,unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location('daily',Path(__file__).parents[1]/'ops/backup-daily.py')
daily=importlib.util.module_from_spec(spec);spec.loader.exec_module(daily)

class RetentionTests(unittest.TestCase):
    def archive(self,root,number):
        path=root/f'quiet-ledger-20261105T0600{number:02d}000Z-00000000-0000-4000-8000-{number:012d}.qlb'
        path.write_bytes(b'QLB\x01'+b'x'*100);path.chmod(0o600);return path
    def test_only_older_owned_archives_are_selected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);files=[self.archive(root,n) for n in range(9)]
            (root/'unrelated.txt').write_text('preserve')
            self.assertEqual(daily.retention_candidates(root,os.getuid(),7),files[:2])
            self.assertTrue(all(p.exists() for p in files))
    def test_matching_name_with_bad_permissions_or_header_blocks_pruning(self):
        for mode,header in [(0o644,b'QLB\x01'),(0o600,b'bad!')]:
            with self.subTest(mode=mode),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp);p=self.archive(root,0);p.write_bytes(header+b'x'*100);p.chmod(mode)
                with self.assertRaises(ValueError):daily.retention_candidates(root,os.getuid(),7)
                self.assertTrue(p.exists())
    def test_symlink_and_hard_link_block_pruning(self):
        for hard in [False,True]:
            with self.subTest(hard=hard),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp);p=self.archive(root,0);target=root/'other';p.rename(target)
                if hard:os.link(target,p)
                else:p.symlink_to(target)
                with self.assertRaises(ValueError):daily.retention_candidates(root,os.getuid(),7)
                self.assertTrue(target.exists())

if __name__=='__main__':unittest.main()
