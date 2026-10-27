file_json_output = '/Users/riipen/Sites/camo-cpq/test/output.json'

import requests, json, csv, io, re

sheet_id = "14zzAWJNgDxZgXAm713sq3K8fhWDNJPZ49SGYssBQH00"
sheet_gids = {
    'Categories': 512714440,
    'Products': 1610198502,
    'Add-ons': 1688740072
}


def price_string_to_float(s):
    return float(re.sub(r"[^\d.]", "", s))


def get_sheet(sheet_id, gid):
    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/gviz/tq"
    params = {
        'gid': gid,
        'tqx': 'out:csv'
    }
    response = requests.get(url, params=params)
    print(f"    get_sheet: {response.status_code}")

    if not response.status_code == 200:
        return {}

    ret_json = { 'cols': {}, 'rows': [] }

    for row in csv.DictReader(io.StringIO(response.text)):
        ret_json['rows'].append(row)
        
        for key, value in row.items():
            if value:
                if key not in ret_json['cols']:
                    ret_json['cols'][key] = []
                ret_json['cols'][key].append(value)
        
    return ret_json


ret_json = {'product_categories': {}, 'addon_categories': {}, 'products': {}, 'addons': {}}

sheet_json = get_sheet(sheet_id, sheet_gids['Categories'])
ret_json['product_categories'] = sheet_json['cols']['Product Categories']
ret_json['addon_categories'] = sheet_json['cols']['Add-on Categories']

sheet_json = get_sheet(sheet_id, sheet_gids['Products'])
for row in sheet_json['rows']:
    ret_json['products'][row['Product SKU']] = {
        'category': row['Product Category'],
        'manufacturer': row['Manufacturer'],
        'sku': row['Product SKU'],
        'name': row['Product Name'],
        'description': row['Product Description'],
        'unit_price': price_string_to_float(row['Our Price']),
    }

sheet_json = get_sheet(sheet_id, sheet_gids['Add-ons'])
for row in sheet_json['rows']:
    ret_json['addons'][row['Add-on SKU']] = {
        'category': row['Add-on Category'],
        'manufacturer': row['Manufacturer'],
        'sku': row['Add-on SKU'],
        'name': row['Add-on Name'],
        'description': row['Add-on Description'],
        'unit_price': price_string_to_float(row['Our Price']),
        'parent_skus': row['Compatible Parent SKUs'].replace(' ', '').split(","),
        'incompatible_skus': row['Incompatible Add-on SKUs'].replace(' ', '').split(","),
    }

print(f'writing to {file_json_output}')
with open(file_json_output, 'w') as file:
    json.dump(ret_json, file, indent=4, ensure_ascii=False)
