// Example: user journey against the bundled demo API (npm run demo-target).
// Shows groups, token extraction, tagged requests, checks and thresholds.
import http from 'k6/http';
import { check, group, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3333';

export const options = {
  scenarios: {
    shoppers: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '15s', target: 20 },
        { duration: '30s', target: 20 },
        { duration: '15s', target: 60 },
        { duration: '30s', target: 60 },
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<300', 'p(99)<800'],
    http_req_failed: ['rate<0.02'],
    checks: ['rate>0.98'],
    'http_req_duration{name:Search}': ['p(95)<250'],
  },
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export default function () {
  let token;

  group('Login', () => {
    const res = http.post(`${BASE_URL}/api/login`, JSON.stringify({ username: `user${__VU}`, password: 'demo' }), {
      headers: JSON_HEADERS, tags: { name: 'Login' },
    });
    check(res, { 'login: status 200': (r) => r.status === 200, 'login: got token': (r) => !!r.json('token') });
    token = res.json('token');
  });
  sleep(0.5);

  group('Browse', () => {
    const list = http.get(`${BASE_URL}/api/products?page=${1 + (__ITER % 5)}`, { tags: { name: 'List products' } });
    check(list, { 'list: status 200': (r) => r.status === 200 });
    const id = 1 + Math.floor(Math.random() * 50);
    const item = http.get(`${BASE_URL}/api/products/${id}`, { tags: { name: 'Product detail' } });
    check(item, { 'detail: status 200': (r) => r.status === 200 });
    const search = http.get(`${BASE_URL}/api/search?q=product%20${id % 10}`, { tags: { name: 'Search' } });
    check(search, { 'search: status 200': (r) => r.status === 200 });
  });
  sleep(1);

  group('Add to cart', () => {
    const res = http.post(`${BASE_URL}/api/cart`, JSON.stringify({ productId: 3, qty: 1 }), {
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` }, tags: { name: 'Add to cart' },
    });
    check(res, { 'cart: status 201': (r) => r.status === 201 });
  });
  sleep(1 + Math.random());
}
