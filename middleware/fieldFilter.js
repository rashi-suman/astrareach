'use strict';

/**
 * Strip a contact (or array of contacts) down to only the allowed fields.
 * Also handles nested custom_fields: only expose keys listed in allowedFields
 * as 'custom_fields.keyName'.
 */
function filterContactFields(contact, allowedFields) {
  if (!contact || !allowedFields) return contact;

  // Determine base fields vs custom sub-keys
  const baseFields   = allowedFields.filter(f => !f.startsWith('custom_fields.'));
  const customKeys   = allowedFields
    .filter(f => f.startsWith('custom_fields.'))
    .map(f => f.slice('custom_fields.'.length));

  const filtered = {};
  for (const field of baseFields) {
    if (Object.prototype.hasOwnProperty.call(contact, field)) {
      filtered[field] = contact[field];
    }
  }

  // Handle custom_fields sub-key restriction
  if (baseFields.includes('custom_fields') && contact.custom_fields) {
    if (customKeys.length > 0) {
      const cf = {};
      for (const k of customKeys) {
        if (Object.prototype.hasOwnProperty.call(contact.custom_fields, k)) {
          cf[k] = contact.custom_fields[k];
        }
      }
      filtered.custom_fields = cf;
    } else {
      filtered.custom_fields = contact.custom_fields;
    }
  }

  return filtered;
}

/**
 * Filter an array of contacts.
 */
function filterContactsArray(contacts, allowedFields) {
  if (!Array.isArray(contacts)) return contacts;
  return contacts.map(c => filterContactFields(c, allowedFields));
}

module.exports = { filterContactFields, filterContactsArray };
