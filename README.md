# DSWD Sanctuary Center Foodstuff Delivery Monitoring System

A no-build-step application using plain HTML, CSS, and vanilla JavaScript ES modules. Firebase Authentication provides Google sign-in, Firestore stores workspace and access data, and Firebase Hosting serves the application. The app uses no Cloud Functions and is intended to run on the Firebase Spark plan.

## Run and deploy

Serve the `public` directory with Firebase Hosting or another local static server. Opening the page with `file://` may not work because the application uses ES modules and Firebase.

```bash
firebase serve --only hosting
```

Before deploying:

1. Ensure the Firebase CLI is logged in and the active project is `sc-foodstuff-monitoring-system`.
2. Enable **Google** under Firebase Authentication → Sign-in method, and add the Hosting and local development domains to Authorized domains.
3. Deploy the supplied Firestore rules before using the updated client.

Deploy with:

```bash
firebase deploy --only firestore:rules,hosting
```

The Firebase project configured by `.firebaserc` is `sc-foodstuff-monitoring-system`.

## Using the matrix

- The matrix has six tabs: Lot 1 Vegetables and Fruits, Lot 2 Fish and Seafoods, Lot 3 Pork and Beef Meat, Lot 4 Chicken Products and Eggs, Lot 5 Grocery Items, and Rice.
- Choose a year, month, and lot. Each lot has independent delivery dates and items.
- Every selected month is initialized with all six lots (Lot 1–5 and Rice) together, ready for data entry; empty lots remain blank until populated.
- Edit item details and proposed/actual delivery quantities in the matrix. Use **Log Delivery** to record catch-up deliveries.
- Delivery dates cannot be duplicated within a lot, and non-empty item names must be unique within that lot.
- Over-delivery is allowed only after confirmation. Prices and quantities cannot be negative.
- Add comments to a matrix cell with its plus marker or by right-clicking it. The signed-in Google email is used for comments, replies, and audit attribution.
- Reply to, resolve, or reopen discussion threads. The Comments Center filters by year, month, lot, item, status, author, and unread state; it also supports direct replies and resolution actions and links to the relevant matrix cell.
- Notifications for comments, replies, and status changes can be marked read individually or all at once. Comment and notification read state is stored per browser.
- **Export CSV** downloads the active lot. **Export all data** downloads matrix data, units, comments and replies, notifications, and audit history as JSON or CSV for a selected year or all years.
- The Audit Log view can filter change history by date, author, and lot. Deleting a row retains its full previous item and delivery values in the history.

## Workspace views

- The hamburger menu opens independent views for the Monthly Matrix, Monthly Overview / Summary, Comments Center, Notifications, Configuration, and Print / Export. Administrators also have Login History, Users & Access, Change Password, and Audit Log.
- The selected view is encoded in the URL hash, so reloading and browser back/forward navigation return to the corresponding view. Administrator-only hashes show an access-restricted view to other accounts.
- Monthly Overview lists undelivered quantities by lot and unit with amounts and a month grand total; selecting a lot opens its matrix.
- Configuration saves measurement units to Firestore and shows the fixed lot names. The Change Password view confirms the new password before saving it.
- Use Card view on any screen size to edit one matrix item at a time, or Table view to access the full horizontally scrollable matrix.

## Data and calculations

- Matrix documents use `matrices/{year}_{month}_{lot}` with related item, delivery-date, delivery-entry, and catch-up-delivery records.
- Cell comments are stored in each matrix document's `comments` subcollection; replies are nested under each comment. Notifications and audit entries are stored in top-level collections.
- Matrix edits and their audit entries are written together in a Firestore transaction. Writes update only changed records. If another browser has already changed the same record, the edit is rejected and the latest matrix is reloaded instead of overwriting it.
- Audit entries record the signed-in email, action, old/new values, lot, period, and Firestore server timestamp.
- Proposed total is the sum of scheduled proposed quantities. Actually delivered is scheduled actual quantities plus catch-up quantities. Undelivered is `max(0, proposed - actually delivered)`; over-delivery is flagged separately.
- The matrix shows proposed and delivered totals as PHP amounts using each item's unit price; the delivered amount includes catch-up deliveries. Quantity totals are still included in the active-lot CSV export.
- Quantities are totaled by unit instead of combining unlike units. Currency is PHP (₱). Dates and times shown by the app use Asia/Manila.
- User-provided text is rendered as text, not interpreted as HTML.

## Security notice

Sign in with Google. Administrators `asanctuary171@gmail.com` and `sc.foncr@dswd.gov.ph` enter directly. Other verified accounts must enter the shared password and have an administrator approve their access request. Pending accounts are checked every 30 seconds. Administrators can change the shared password, approve or reject requests, review filtered login history, and revoke or restore member access. A changed password requires approved members to enter it again. Login and explicit logout events are logged once per browser-tab session. No Cloud Functions or paid Firebase plan is required.

The client hashes passwords with SHA-256 using Web Crypto. Firestore rules compare a member's stored hash with the administrator-controlled `config/gate` hash before permitting workspace access. Members can read their own member document, including its password hash, so the shared password hash is susceptible to offline guessing. Use a long, unique shared password. If the gate has not been configured, non-admin attempts show a combined wrong-password/unset-password message because the supplied rules reserve gate reads to administrators.
