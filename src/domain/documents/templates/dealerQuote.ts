/** System template: a sales quote for a vehicle (version 1). */
export const DEALER_QUOTE_V1 = `<h1 class="center">Quotation</h1>
<p class="center small">{{document.number}} · {{date document.issuedOn}} · quote {{quote.number}} · valid until {{date quote.validUntil}}</p>

<h2>Prepared for</h2>
<table>
  <tr><th data-width="30">Customer</th><td>{{customer.name}}</td></tr>
  {{#if customer.phone}}<tr><th>Phone</th><td>{{customer.phone}}</td></tr>{{/if}}
  <tr><th>Prepared by</th><td>{{issuer.name}}{{#if issuer.phone}}, {{issuer.phone}}{{/if}}</td></tr>
</table>

<h2>Vehicle</h2>
<table>
  <tr><th data-width="30">Make and model</th><td>{{vehicle.make}} {{vehicle.model}}{{#if vehicle.year}} ({{vehicle.year}}){{/if}}</td></tr>
  {{#if vehicle.colour}}<tr><th>Colour</th><td>{{vehicle.colour}}</td></tr>{{/if}}
  {{#if vehicle.vin}}<tr><th>VIN</th><td>{{vehicle.vin}}</td></tr>{{/if}}
  {{#if vehicle.plateNumber}}<tr><th>Registration</th><td>{{upper vehicle.plateNumber}}</td></tr>{{/if}}
  {{#if vehicle.odometer}}<tr><th>Odometer</th><td>{{number vehicle.odometer}}</td></tr>{{/if}}
</table>

<h2>Price</h2>
<table>
  <thead><tr><th data-width="70">Item</th><th>Amount</th></tr></thead>
  <tbody>
  <tr><td>Vehicle price</td><td>{{money quote.price}}</td></tr>
  {{#if quote.hasDiscount}}<tr><td>Discount</td><td>- {{money quote.discount}}</td></tr>{{/if}}
  {{#each addOns}}<tr><td>{{description}}</td><td>{{money amount}}</td></tr>
  {{/each}}
  <tr><td><strong>Total</strong></td><td><strong>{{money quote.total}}</strong></td></tr>
  {{#if quote.tradeIn}}<tr><td>Trade-in: {{quote.tradeIn}}</td><td>- {{money quote.tradeInValue}}</td></tr>
  <tr><td><strong>Balance to pay</strong></td><td><strong>{{money quote.balance}}</strong></td></tr>{{/if}}
  </tbody>
</table>

<h2>Payment</h2>
<p>{{quote.financing}}{{#if quote.deposit}}: a deposit of {{money quote.deposit}}{{/if}}{{#if quote.termMonths}} and the balance over {{quote.termMonths}} months{{/if}}.{{#if quote.financingNote}} {{quote.financingNote}}{{/if}}</p>
{{#if quote.notes}}<p>{{quote.notes}}</p>{{/if}}

<section data-clause="quote_terms" data-title="Terms" data-locked>
<p>This quotation is valid until the date shown and is subject to the vehicle still being available. Prices are in {{quote.currency}}. A trade-in value holds only after the vehicle traded in has been inspected. Nothing is reserved until a deposit is paid.</p>
</section>

<signature-block>
  <signer role="business" label="For the dealer" name="{{issuer.name}}"></signer>
  <signer role="customer" label="Accepted by the customer" name="{{customer.name}}"></signer>
</signature-block>
`;
