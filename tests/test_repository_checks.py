"""Regression cases for publication checks, using fictional data only."""

import unittest
import io
from unittest.mock import patch

from scripts.check_commits import revision_range, valid_subject, verification
from scripts.check_repository import heading_ids, link_errors, private_path, template_errors


class PublicationChecks(unittest.TestCase):
    def test_private_files_cannot_be_committed(self):
        for name in ['.env', '.env.local', '.dev.vars', '.dev.vars.local', 'docs/private/notes.md', 'uploads/signed.pdf',
                     'service-account.json', 'google-mail-token.json', 'signing.key']:
            with self.subTest(name=name):
                self.assertTrue(private_path(name))
        for name in ['.env.example', '.env.test.example', '.dev.vars.example', 'docs/email-design.md']:
            self.assertFalse(private_path(name))

    def test_template_rejects_values_and_duplicates_without_echoing_them(self):
        self.assertEqual(template_errors('# Comment\nAPP_URL=\n'), [])
        errors = template_errors('APP_URL=https://example.com\nNAME=\nNAME=\n')
        self.assertEqual(len(errors), 2)
        self.assertNotIn('https://example.com', '\n'.join(errors))

    def test_local_links_must_target_tracked_files_and_valid_chinese_anchors(self):
        files = {'docs/guide.md': '# 设备状态\n\n## 状态\n\n## 状态\n'}
        self.assertEqual(link_errors('README.md', '[说明](docs/guide.md#设备状态)', files), [])
        self.assertEqual(link_errors('README.md', '[说明](docs/guide.md#状态-1)', files), [])
        self.assertTrue(link_errors('README.md', '[说明](docs/guide.md#缺失)', files))
        self.assertTrue(link_errors('README.md', '[说明](.env)', files))
        self.assertTrue(link_errors('README.md', '[说明](../outside.md)', files))

    def test_external_links_and_fenced_examples_do_not_require_network(self):
        content = '[官方](https://example.com/path)\n```md\n[示例](missing.md)\n```\n'
        self.assertEqual(link_errors('README.md', content, {}), [])
        self.assertNotIn('fake', heading_ids('```\n# Fake\n```\n# Real\n'))

    def test_subject_rules(self):
        self.assertTrue(valid_subject('ci: add repository verification'))
        for subject in ['', '配置自动检查', 'one two three four five six seven eight']:
            self.assertFalse(valid_subject(subject))

    def test_pull_request_range_excludes_synthetic_merge(self):
        base, head, merge = 'a' * 40, 'b' * 40, 'c' * 40
        event = {'pull_request': {'base': {'sha': base}, 'head': {'sha': head}}}
        self.assertEqual(revision_range('pull_request', event, merge), f'{base}..{head}')
        self.assertEqual(revision_range('push', {'before': base}, head), f'{base}..{head}')
        self.assertEqual(revision_range('push', {'before': '0' * 40}, head), head)
        self.assertEqual(revision_range('workflow_dispatch', {}, head), head)

    def test_signature_check_requires_verified_api_result(self):
        for verified in [True, False]:
            with self.subTest(verified=verified):
                result = '{"commit":{"verification":{"verified":' + str(verified).lower() + ',"reason":"valid"}}}'
                with patch('scripts.check_commits.urlopen', return_value=io.StringIO(result)):
                    self.assertEqual(verification('example/gear', 'a' * 40, 'fictional'), verified)


if __name__ == '__main__':
    unittest.main()
