const slug = require('../utils/slug');

test('basic slugify', () => {
  expect(slug('Hello World')).toBe('hello-world');
});
test('strips punctuation', () => {
  expect(slug('  Foo!! Bar?? ')).toBe('foo-bar');
});
