import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('retention', Path(__file__).with_name('prune-release-images.py'))
assert spec is not None and spec.loader is not None
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def fixture():
    images = []
    for n in range(1, 6):
        rev = f'{n:040x}'
        images.append({'Id': f'sha256:{n:064x}', 'Created': f'2026-01-0{n}T00:00:00Z',
                       'Config': {'Labels': {m.LABEL: rev}}, 'RepoTags': ['cascade:certified-' + rev]})
    for n in range(1, 5):
        images[n-1]['RepoTags'].append('cascade:rollback-' + f'{n+1:040x}')
    images[-1]['RepoTags'].append('cascade:latest')
    return images, {'Image': images[-1]['Id']}


class RetentionTests(unittest.TestCase):
    def test_host_hook_is_after_verified_deploy_not_read_only_verify(self):
        source = Path(__file__).with_name('github-actions-host.sh').read_text()
        hook = 'python3 /usr/local/lib/fizzer/prune-release-images.py --apply --lock-fd "$DEPLOY_LOCK_FD"'
        self.assertEqual(source.count(hook), 1)
        self.assertTrue(source.rstrip().endswith('verify_revision\n\n# Operator-installed scoped retention survives exact-revision checkout/reset.\n# Run only after successful cutover/healthy exact-revision retry, under this lock.\n' + hook))
        self.assertLess(source.index('if [[ "$action" == "verify" ]]'), source.index(hook))

    def test_distinct_images_not_tags_and_rollback_suffix_is_target(self):
        images, live = fixture()
        p = m.plan(images, live, [live], {})
        self.assertEqual([x['id'] for x in p['lineage']], [i['Id'] for i in images[::-1][:3]])
        self.assertEqual(len(p['remove']), 2)
        self.assertEqual(len(p['remove'][0]['tags']), 2)

    def test_references_containers_pointer_tags_preserved(self):
        images, live = fixture()
        images[1]['RepoTags'].append('cascade:operator-pin')
        p = m.plan(images, live, [live], {'snapshot': [images[0]['Id']]})
        self.assertEqual(p['remove'], [])
        p = m.plan(images, live, [live, {'Image': images[0]['Id']}], {})
        self.assertEqual(p['remove'], [])

    def test_legacy_revision_protects_both_sides(self):
        images, live = fixture()
        p = m.plan(images, live, [live], {'snapshot/revision.txt': [f'{2:040x}']})
        self.assertEqual(p['remove'], [])

    def test_no_age_sort_for_lineage(self):
        images, live = fixture()
        images[2]['Created'] = '2020-01-01T00:00:00Z'
        self.assertEqual(m.plan(images, live, [live], {})['lineage'][2]['id'], images[2]['Id'])

    def test_missing_or_self_rollback_fails_closed(self):
        images, live = fixture()
        images[3]['RepoTags'].remove('cascade:rollback-' + f'{5:040x}')
        with self.assertRaises(ValueError): m.plan(images, live, [live], {})
        images[-1]['RepoTags'].append('cascade:rollback-' + f'{5:040x}')
        with self.assertRaises(ValueError): m.plan(images, live, [live], {})

    def test_unknown_tags_and_newer_staged_images_not_deleted(self):
        images, live = fixture()
        images[0]['RepoTags'] = ['another-app:latest']
        images[1]['Created'] = '2027-01-01T00:00:00Z'
        self.assertEqual(m.plan(images, live, [live], {})['remove'], [])

    def test_missing_reference_reported_not_fabricated(self):
        images, live = fixture()
        missing = 'sha256:' + 'f' * 64
        self.assertEqual(m.plan(images, live, [live], {'waiver': [missing]})['missing_referenced_images'], [{'path': 'waiver', 'image': missing}])

    def test_latest_mismatch_refuses(self):
        images, live = fixture()
        images[-1]['RepoTags'].remove('cascade:latest')
        with self.assertRaises(ValueError): m.plan(images, live, [live], {})


if __name__ == '__main__': unittest.main()
