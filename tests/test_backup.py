"""Archive boundaries without database, credentials, or network."""
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

spec=importlib.util.spec_from_file_location('backup',Path(__file__).resolve().parents[1]/'scripts/backup.py')
backup=importlib.util.module_from_spec(spec);spec.loader.exec_module(backup)
class BackupTests(unittest.TestCase):
    def test_rejects_traversal_symlinks_duplicate_and_unknown_members(self):
        for name,kind in [('../escape','file'),('/escape','file'),('website/link','symlink'),('database.dump','duplicate'),('secrets/file','file'),('website/.env','file')]:
            with self.subTest(name=name),tempfile.TemporaryDirectory() as temporary:
                archive=Path(temporary)/'archive.tar.gz'
                with tarfile.open(archive,'w:gz') as output:
                    item=tarfile.TarInfo(name)
                    if kind=='symlink':item.type=tarfile.SYMTYPE;item.linkname='/tmp/example'
                    else:item.size=1
                    output.addfile(item,io.BytesIO(b'x'))
                    if kind=='duplicate':output.addfile(item,io.BytesIO(b'x'))
                with self.assertRaises(backup.BackupError):backup.unpack_backup(archive,Path(temporary)/'out')
    def test_rejects_tampered_hash_and_missing_original_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive=Path(temporary)/'bad.tar.gz'
            manifest={'format':backup.FORMAT,'schema':'gear_2026','private_schema':'gear_private_2026','auth_ids':[],'originals':[],
                      'files':{'database.dump':{'size':1,'sha256':'0'*64},'website/index.html':{'size':1,'sha256':'0'*64}}}
            with tarfile.open(archive,'w:gz') as output:
                for name,data in [('manifest.json',json.dumps(manifest).encode()),('database.dump',b'x'),('website/index.html',b'x')]:
                    item=tarfile.TarInfo(name);item.size=len(data);output.addfile(item,io.BytesIO(data))
            with self.assertRaisesRegex(backup.BackupError,'SHA-256'):backup.unpack_backup(archive,Path(temporary)/'out')
    def test_only_built_website_and_year_schemas(self):
        with self.assertRaises(backup.BackupError):backup.names('public;drop schema public')
        self.assertEqual(backup.names('gear_2030'),('gear_2030','gear_private_2030'))
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);(root/'index.html').write_text('example');(root/'.env').write_text('example')
            with self.assertRaises(backup.BackupError):backup.web_files(root)
class StorageHttpTests(unittest.TestCase):
    key='00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002'
    def storage(self):
        with patch.dict(backup.os.environ,{'SUPABASE_URL':'https://backend.example.invalid/','GEAR_STORAGE_BUCKET':'example-evidence','SUPABASE_SECRET_KEY':'sb_secret_example'}):
            return backup.Storage()
    def respond(self,storage,status,body):
        error=HTTPError('https://backend.example.invalid/',status,'example',{},io.BytesIO(body if isinstance(body,bytes) else json.dumps(body).encode()))
        storage.opener.open=lambda *args,**kwargs: (_ for _ in ()).throw(error)
    def test_get_recognizes_only_missing_keys_in_both_http_formats(self):
        for status,body in [(400,{'statusCode':'404','code':'NoSuchKey','message':'Object not found'}),(404,{'statusCode':404,'code':'NoSuchKey'}),(400,{'statusCode':'404','error':'not_found','message':'Object not found'})]:
            with self.subTest(status=status,body=body):
                storage=self.storage();self.respond(storage,status,body)
                self.assertIsNone(storage.get(self.key))
    def test_denied_access_missing_buckets_and_bad_responses_fail_closed(self):
        for status,body in [(400,{'statusCode':'404','code':'NoSuchBucket'}),(404,{'code':'NoSuchBucket'}),(400,{'statusCode':'403','code':'AccessDenied'}),(403,{'code':'NoSuchKey'}),(400,{'statusCode':'403','code':'NoSuchKey'}),(404,b'<html>Not found</html>'),(400,[]),(400,{'statusCode':'404','error':'not_found','message':'Bucket not found'}),(400,b'x'*65537)]:
            with self.subTest(status=status):
                storage=self.storage();self.respond(storage,status,body)
                with self.assertRaises(backup.BackupError):storage.get(self.key)
    def test_upload_error_is_never_a_successful_missing_key(self):
        storage=self.storage();self.respond(storage,400,{'statusCode':'404','code':'NoSuchKey'})
        with self.assertRaises(backup.BackupError):storage.put(self.key,b'example','application/pdf')

if __name__=='__main__':unittest.main()
