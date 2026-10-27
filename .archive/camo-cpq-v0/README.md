# Camo CPQ Webapp

This is a pricing calculator for that works offline and integrates with HubSpot.


- grab the products from hubspot
- differentiate between products & add-ons
- know which products can go with which add-ons
- product picker
  - show products & their costs
  - show available add-ons & their costs
  - don't show sku on frontend
  - show name in black with description in smaller gray underneath
  - can only choose 1 product
- add-on picker
  - all the same as above, only show ones with compatible parent skus
  - can choose multiple add-ons.  once an addon is chosen, grey out the ones with incompatible skus
  - only show add-ons that have the parent sku of the product

- this has to work well on an ipad and/or on a phone.

---
*Created Aug 2025 by Chris Becher (chris.becher@profitpad.com) on behalf of ProfitPad for Camo*
*Site hosted at https://app.netlify.com/projects/camo-cpq/overview*