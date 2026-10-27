/** System template: car rental agreement, signed at check-out (version 1). */
export const RENTAL_AGREEMENT_V1 = `<h1 class="center">Vehicle rental agreement</h1>
<p class="center small">{{document.number}} · {{date document.issuedOn}} · booking {{rental.number}}</p>

<h2>Parties</h2>
<table>
  <tr><th data-width="30">Owner</th><td>{{issuer.name}}{{#if issuer.tin}} (TIN {{issuer.tin}}){{/if}}{{#if issuer.phone}}, {{issuer.phone}}{{/if}}</td></tr>
  <tr><th>Renter</th><td>{{renter.name}} ({{renter.code}}){{#if renter.phone}}, {{renter.phone}}{{/if}}{{#if renter.email}}, {{renter.email}}{{/if}}</td></tr>
  {{#if renter.address}}<tr><th>Renter's address</th><td>{{renter.address}}</td></tr>{{/if}}
  <tr><th>Driver</th><td>{{driver.name}}{{#if driver.phone}}, {{driver.phone}}{{/if}}</td></tr>
  <tr><th>Ghana Card</th><td>{{driver.ghanaCardNumber}}</td></tr>
  <tr><th>Driving licence</th><td>{{driver.licenceNumber}}{{#if driver.licenceExpiresOn}}, valid until {{date driver.licenceExpiresOn}}{{/if}}</td></tr>
</table>

<h2>Vehicle</h2>
<table>
  <tr><th data-width="30">Registration</th><td>{{upper vehicle.plateNumber}}</td></tr>
  <tr><th>Make and model</th><td>{{vehicle.make}} {{vehicle.model}}{{#if vehicle.year}} ({{vehicle.year}}){{/if}}</td></tr>
  <tr><th>Colour</th><td>{{vehicle.colour}}</td></tr>
  <tr><th>Chassis / VIN</th><td>{{vehicle.vin}}</td></tr>
  <tr><th>Odometer out</th><td>{{number rental.odometer}} {{rental.unit}}</td></tr>
  <tr><th>Fuel out</th><td>{{rental.fuel}}</td></tr>
</table>

<h2>Rental</h2>
<table>
  <tr><th data-width="30">Collected</th><td>{{date rental.pickupOn}}, {{rental.pickupTime}} at {{rental.branch}}</td></tr>
  <tr><th>Return by</th><td>{{date rental.returnOn}}, {{rental.returnTime}}</td></tr>
  <tr><th>Rate plan</th><td>{{rental.plan}}</td></tr>
  <tr><th>Mileage</th><td>{{rental.mileage}}</td></tr>
  {{#if rental.deposit}}<tr><th>Security deposit</th><td>{{money rental.deposit}}</td></tr>{{/if}}
</table>

<h2>Charges</h2>
<table>
  <thead><tr><th data-width="70">Item</th><th>Amount</th></tr></thead>
  <tbody>
  {{#each charges}}<tr><td>{{description}}</td><td>{{money amount}}</td></tr>
  {{/each}}
  <tr><th>Total so far</th><th>{{money rental.total}}</th></tr>
  </tbody>
</table>

<h2>Condition at check-out</h2>
<table>
  <thead><tr><th data-width="8">#</th><th data-width="52">Item</th><th data-width="15">OK</th><th>Note</th></tr></thead>
  <tbody>
  {{#each checklist}}<tr><td>{{@number}}</td><td>{{label}}</td><td>{{ok}}</td><td>{{note}}</td></tr>
  {{/each}}
  </tbody>
</table>
{{#if damages}}
<p><strong>Damage already on the vehicle:</strong></p>
<ul>
{{#each damages}}<li>{{area}} ({{severity}}): {{description}}</li>
{{/each}}
</ul>
{{else}}
<p>No damage was recorded on the vehicle at check-out.</p>
{{/if}}

<section data-clause="renter_responsibility" data-title="The renter's responsibility" data-locked>
<p>The renter confirms that the vehicle, its documents and the items above were received in the condition recorded. Only the driver named above may drive the vehicle. The renter will use it with care, obey road traffic law, not drive under the influence of alcohol or drugs, not sublet it, and report any accident, damage, breakdown, theft or police matter to the owner at once. Fines, tolls and charges incurred during the rental are the renter's to pay.</p>
</section>

<section data-clause="return_and_charges" data-title="Return and further charges" data-locked>
<p>The vehicle is returned by the time above, to the branch it was collected from unless agreed otherwise, with the same fuel level. A later return is charged at the booked rates for the time kept, and kilometres beyond those included at the extra kilometre rate; missing fuel, cleaning and damage beyond fair wear and tear found at the return are charged as well.</p>
</section>

<section data-clause="deposit_and_damage" data-title="Deposit and damage">
<p>Any security deposit is held, not spent, and may be applied to what the rental owes, including damage; what is left is returned once the vehicle is back and the charges are settled.</p>
</section>

<signature-block>
  <signer role="business" label="For the owner" name="{{issuer.name}}"></signer>
  <signer role="renter" label="Renter" name="{{rental.signatory}}"></signer>
</signature-block>
`;
