"""Check deployment boundaries without connecting to production services."""

from pathlib import Path
import importlib.util
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('deploy', Path(__file__).resolve().parents[1] / 'scripts/deploy.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class DeploymentBoundaries(unittest.TestCase):
    def environment(self):
        env = {name: 'example' for name in deploy.REQUIRED}
        env.update(
            GITHUB_REF='refs/heads/main', GITHUB_EVENT_NAME='push', GITHUB_SHA='a' * 40,
            DEPLOY_HOST='192.0.2.10', DEPLOY_PORT='22', CI_DEPLOY_USER='example-deploy',
            PUBLIC_APP_URL='https://app.example.com', PUBLIC_API_URL='https://api.example.com',
            SUPABASE_URL='https://backend.example.com',
            SUPABASE_PUBLISHABLE_KEY='sb_publishable_example',
            AWS_DEPLOY_ROLE_ARN='arn:aws:iam::123456789012:role/example-deploy',
        )
        return env

    def test_only_trusted_main_workflow_may_deploy(self):
        env = self.environment()
        deploy.validate(env)
        for name, value in (
            ('GITHUB_EVENT_NAME', 'pull_request'), ('GITHUB_REF', 'refs/heads/other'),
            ('GITHUB_SHA', 'HEAD'), ('DEPLOY_HOST', '-oProxyCommand=example'),
            ('CI_DEPLOY_USER', 'example;exit'), ('DEPLOY_PORT', '0'),
            ('SUPABASE_PUBLISHABLE_KEY', 'sb_secret_example'),
            ('GEAR_DB_SCHEMA', 'gear;SELECT 1'), ('GEAR_DB_SCHEMA', ''),
        ):
            with self.subTest(name=name), self.assertRaises(ValueError):
                deploy.validate(dict(env, **{name: value}))

    def test_browser_origins_reject_credentials_paths_and_plain_http(self):
        for value in ('http://example.com', 'https://user:password@example.com',
                      'https://example.com/api', 'https://example.com/?token=example',
                      'https://example.com/#example', 'https:///'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                deploy.https_origin(value)

    def test_publishable_output_rejects_links_private_files_and_server_keys(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'index.html').write_text('example\n')
            self.assertEqual(len(deploy.public_files(root)), 1)
            (root / 'sdk.js').write_text('const prefix = "sb_secret_";')
            self.assertEqual(len(deploy.public_files(root)), 2)
            (root / 'sdk.js').unlink()
            for name, value in (('.env', 'example'), ('identity.key', 'example'),
                                ('bundle.js', 'sb_secret_example')):
                path = root / name
                path.write_text(value)
                with self.subTest(name=name), self.assertRaises(ValueError):
                    deploy.public_files(root)
                path.unlink()
            (root / 'linked.html').symlink_to(root / 'index.html')
            with self.assertRaises(ValueError):
                deploy.public_files(root)

    def test_private_credentials_use_restricted_files_and_are_removed(self):
        with deploy.private_files() as temporary:
            path = temporary / 'identity'
            path.write_text('fake credential')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertFalse(temporary.exists())

    def test_deploys_only_matching_uploaded_version(self):
        revision = 'a' * 40
        versions = [
            {'id': '11111111-1111-4111-8111-111111111111', 'number': 1,
             'annotations': {'workers/message': 'Deploy ' + revision}},
            {'id': '22222222-2222-4222-8222-222222222222', 'number': 2,
             'annotations': {'workers/message': 'Deploy ' + revision}},
            {'id': '33333333-3333-4333-8333-333333333333', 'number': 3,
             'annotations': {'workers/message': 'Unrelated version'}},
        ]
        self.assertEqual(deploy.selected_version(versions, revision), versions[1]['id'])
        with self.assertRaises(RuntimeError):
            deploy.selected_version(versions, 'b' * 40)


if __name__ == '__main__':
    unittest.main()
