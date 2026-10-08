import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';

import { takeDown } from './dom.js';

afterEach(takeDown);
