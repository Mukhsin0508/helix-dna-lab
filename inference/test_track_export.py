"""Tests use synthetic numeric fixtures only; they are not model predictions."""

import json
import unittest

from track_export import (
    REFERENCE_WINDOW, crop_indices, json_value, metadata_records,
    select_biosample, track_payload, validate_reference,
)


class TrackExportTests(unittest.TestCase):
    def test_known_reference_and_mismatch(self) -> None:
        self.assertEqual(validate_reference(REFERENCE_WINDOW.lower()), REFERENCE_WINDOW)
        with self.assertRaises(ValueError):
            validate_reference(REFERENCE_WINDOW[:20] + "A" + REFERENCE_WINDOW[21:])

    def test_crop_coordinates_and_bounds(self) -> None:
        self.assertEqual(crop_indices(100, 110, 1, 10, 102, 106), (2, 6))
        self.assertEqual(crop_indices(100, 120, 2, 10, 104, 112), (2, 6))
        for args in [(100, 110, 1, 10, 99, 103), (100, 120, 2, 10, 103, 110), (100, 120, 1, 10, 104, 112)]:
            with self.assertRaises(ValueError):
                crop_indices(*args)

    def test_metadata_selection_is_exact(self) -> None:
        records = metadata_records('[{"name":"example","biosample_name":"glutamatergic neuron","ontology_curie":"CL:example","strand":"+"}]')
        self.assertEqual(select_biosample(records, "glutamatergic neuron"), ["CL:example"])
        with self.assertRaises(ValueError):
            select_biosample(records, "neuron")

    def test_serialization_preserves_numeric_rows(self) -> None:
        metadata = [{"name": "fixture", "strand": "+"}]
        payload = track_payload([[0.0], [1.25]], metadata, start=100, end=102, resolution=1)
        self.assertEqual(json.loads(json.dumps(payload, allow_nan=False))["values"], [[0.0], [1.25]])
        self.assertEqual(payload["metadata"], metadata)

    def test_invalid_values_and_shapes_rejected(self) -> None:
        for value in [float("nan"), float("inf")]:
            with self.assertRaises(ValueError):
                json_value(value)
        for rows in [[[True]], [[1.0, 2.0]], [[None]]]:
            with self.assertRaises(ValueError):
                track_payload(rows, [{"name": "fixture"}], start=0, end=1, resolution=1)


if __name__ == "__main__":
    unittest.main()
