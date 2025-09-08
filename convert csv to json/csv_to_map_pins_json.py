import csv
import json

def csv_to_map_pins_json(csv_file_path, json_file_path):
    output = []

    with open(csv_file_path, newline='', encoding='utf-8') as csvfile:
        reader = csv.DictReader(csvfile)
        for i, row in enumerate(reader):
            try:
                lat = float(row.get('latitude', 0))
                lon = float(row.get('longitude', 0))
            except ValueError:
                continue

            if lat == 0 or lon == 0:
                continue

            record = {
                "name": row.get("name", "").strip(),
                "description": row.get("description", "").strip(),
                "lat": lat,
                "lon": lon,
                "source": row.get("source", "").strip()
            }

            output.append(record)

    with open(json_file_path, 'w', encoding='utf-8') as jsonfile:
        json.dump(output, jsonfile, indent=2)
        print(f"✅ JSON saved to {json_file_path} with {len(output)} valid pins.")

# Example usage
csv_to_map_pins_json('combined_trailheads.csv', 'trailheads-ridb.json')
