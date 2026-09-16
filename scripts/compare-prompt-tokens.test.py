import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('comparison', Path(__file__).with_name('compare-prompt-tokens.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ComparisonTest(unittest.TestCase):
    def test_reconstruction_and_guard_against_lost_responsibility(self):
        original = {'authority': 'Stop remains binding', 'open': 'Stop remains binding'}
        compact = {'authority': 'Stop remains binding', 'open': {'contextRef': ['authority']}}
        self.assertEqual(module.expand(compact, compact), original)
        compact['open'] = {'contextRef': ['missing']}
        with self.assertRaises(KeyError):
            module.expand(compact, compact)

    def test_whole_text_is_tokenized_separately_from_sections(self):
        sample = {'samples': [{'name': 'boundary', 'sections': [
            {'name': 'a', 'before': 'a', 'after': 'a', 'check': 'identical'},
            {'name': 'b', 'before': 'b', 'after': 'b'}]}]}
        result = module.compare(sample, lambda text: [text] if text else [])[0]
        self.assertEqual(result['total']['before'], 1)
        self.assertEqual(result['boundaryDifference']['before'], -1)
        sample['samples'][0]['sections'][0]['after'] = ''
        with self.assertRaises(ValueError):
            module.compare(sample, list)


if __name__ == '__main__':
    unittest.main()
