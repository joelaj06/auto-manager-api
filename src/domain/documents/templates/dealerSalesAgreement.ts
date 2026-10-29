/** System template: the agreement for the sale of a vehicle (version 1). */
export const DEALER_SALES_AGREEMENT_V1 = `<h1 class="center">Vehicle Sales Agreement</h1>
<p class="center small">{{document.number}} · {{date document.issuedOn}} · deal {{deal.number}}</p>

<h2>The parties</h2>
<table>
  <tr><th data-width="30">Seller</th><td>{{issuer.name}}{{#if issuer.address}}, {{issuer.address}}{{/if}}{{#if issuer.tin}} (TIN {{issuer.tin}}){{/if}}</td></tr>
  <tr><th>Buyer</th><td>{{buyer.name}}{{#if buyer.address}}, {{buyer.address}}{{/if}}</td></tr>
  {{#if buyer.phone}}<tr><th>Buyer's phone</th><td>{{buyer.phone}}</td></tr>{{/if}}
  {{#if buyer.ghanaCardNumber}}<tr><th>Ghana Card</th><td>{{buyer.ghanaCardNumber}}</td></tr>{{/if}}
</table>

<h2>The vehicle</h2>
<table>
  <tr><th data-width="30">Make and model</th><td>{{vehicle.make}} {{vehicle.model}}{{#if vehicle.year}} ({{vehicle.year}}){{/if}}</td></tr>
  {{#if vehicle.colour}}<tr><th>Colour</th><td>{{vehicle.colour}}</td></tr>{{/if}}
  {{#if vehicle.vin}}<tr><th>VIN</th><td>{{vehicle.vin}}</td></tr>{{/if}}
  {{#if vehicle.engineNumber}}<tr><th>Engine number</th><td>{{vehicle.engineNumber}}</td></tr>{{/if}}
  {{#if vehicle.plateNumber}}<tr><th>Registration</th><td>{{upper vehicle.plateNumber}}</td></tr>{{/if}}
  {{#if vehicle.odometer}}<tr><th>Odometer</th><td>{{number vehicle.odometer}}</td></tr>{{/if}}
</table>

<h2>Price</h2>
<table>
  <thead><tr><th data-width="70">Item</th><th>Amount</th></tr></thead>
  <tbody>
  <tr><td>Vehicle price</td><td>{{money deal.price}}</td></tr>
  {{#if deal.hasDiscount}}<tr><td>Discount</td><td>- {{money deal.discount}}</td></tr>{{/if}}
  {{#each addOns}}<tr><td>{{description}}</td><td>{{money amount}}</td></tr>
  {{/each}}
  <tr><td><strong>Total (invoice {{deal.invoiceNumber}}, with tax)</strong></td><td><strong>{{money deal.invoiced}}</strong></td></tr>
  {{#if deal.tradeIn}}<tr><td>Trade-in: {{deal.tradeIn}}</td><td>- {{money deal.tradeInValue}}</td></tr>{{/if}}
  </tbody>
</table>

<h2>Payment</h2>
<p>{{deal.financing}}.{{#if deal.lender}} {{money deal.loan}} is lent by {{deal.lender}} and paid to the seller for the buyer.{{/if}}</p>
{{#if deal.hasPlan}}<p>A down payment of {{money deal.downPayment}} before delivery, then {{deal.instalments}} instalments of {{money deal.instalment}} from {{date deal.firstDueOn}} to {{date deal.lastDueOn}}, including an instalment charge of {{money deal.planCharge}}.</p>{{/if}}
{{#if deal.warrantyMonths}}<p>The vehicle carries a warranty of {{deal.warrantyMonths}} months from delivery{{#if deal.serviceVouchers}} and {{deal.serviceVouchers}} free service vouchers{{/if}}.</p>{{/if}}
{{#if deal.notes}}<p>{{deal.notes}}</p>{{/if}}

<section data-clause="sale_terms" data-title="Terms of sale" data-locked>
<p>The vehicle stays the seller's property until the price is paid in full; on instalments, until the last instalment is paid, and missing instalments allows the seller to recover the vehicle. The buyer has inspected the vehicle and accepts it as seen, except for the warranty above. The seller hands over the documents needed to register the vehicle in the buyer's name once it is paid for.</p>
</section>

<signature-block>
  <signer role="business" label="For the seller" name="{{issuer.name}}"></signer>
  <signer role="buyer" label="The buyer" name="{{buyer.name}}"></signer>
</signature-block>
`;
