const lidCache = new Map();

function baseUrl() {
  return (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
}

function headers() {
  const output = {
    'content-type': 'application/json'
  };

  if (process.env.EVOLUTION_API_KEY) {
    output.apikey = process.env.EVOLUTION_API_KEY;
  }

  return output;
}

function digitsFrom(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function lidFrom(identifier) {
  const raw = String(identifier ?? '').trim();
  const beforeAt = raw.split('@')[0];
  return digitsFrom(beforeAt);
}

function isLidIdentifier(identifier) {
  const raw = String(identifier ?? '').trim().toLowerCase();
  const digits = lidFrom(raw);
  console.log('[contact-resolver] isLid check:', {
    raw: identifier,
    digits,
    length: digits.length
  });

  return raw.includes('@lid') || digits.length > 15;
}

async function parseResponse(response) {
  const rawText = await response.text();

  if (!rawText.trim()) return null;

  try {
    return JSON.parse(rawText);
  } catch {
    return rawText;
  }
}

function phoneFromCandidate(value) {
  if (value === null || value === undefined) return null;

  const raw = String(value).trim();
  if (!raw || raw.toLowerCase().includes('@lid')) return null;

  const digits = digitsFrom(raw);
  if (digits.length >= 10 && digits.length <= 15) return digits;

  return null;
}

function findPhoneInResponse(input) {
  if (!input) return null;

  if (typeof input !== 'object') {
    return phoneFromCandidate(input);
  }

  const stack = [input];
  const wantedKeys = ['phone', 'number', 'wid', 'id'];

  while (stack.length) {
    const current = stack.pop();

    if (current && typeof current !== 'object') {
      const phone = phoneFromCandidate(current);
      if (phone) return phone;
      continue;
    }

    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }

    if (!current || typeof current !== 'object') continue;

    for (const wantedKey of wantedKeys) {
      const entry = Object.entries(current)
        .find(([key]) => key.toLowerCase() === wantedKey);

      if (entry) {
        const phone = phoneFromCandidate(entry[1]);
        if (phone) return phone;
      }
    }

    for (const [key, value] of Object.entries(current)) {
      if (value && typeof value === 'object') {
        stack.push(value);
      }
    }
  }

  return null;
}

/**
 * Tenta resolver um identificador para telefone real.
 * Se for telefone normal, retorna direto.
 * Se for LID, consulta a Evolution API para descobrir o telefone.
 *
 * @param {string} identifier - O customerPhone extraido (pode ser LID ou telefone)
 * @param {string} instance - Nome da instancia da Evolution API
 * @returns {Promise<{ phone: string|null, identifier: string, isLid: boolean }>}
 */
export async function resolveContact(identifier, instance) {
  const normalizedIdentifier = lidFrom(identifier);
  const isLid = isLidIdentifier(identifier);

  if (!normalizedIdentifier) {
    return { phone: null, identifier: String(identifier ?? ''), isLid };
  }

  if (!isLid) {
    return {
      phone: normalizedIdentifier,
      identifier: normalizedIdentifier,
      isLid: false
    };
  }

  const cachedPhone = lidCache.get(normalizedIdentifier);
  if (cachedPhone) {
    return {
      phone: cachedPhone,
      identifier: normalizedIdentifier,
      isLid: true
    };
  }

  try {
    const url = baseUrl();

    if (!url || !instance) {
      console.log('[contact-resolver] nao foi possivel resolver LID, aceitando mensagem');
      return { phone: null, identifier: normalizedIdentifier, isLid: true };
    }

    const response = await fetch(`${url}/chat/findContacts/${encodeURIComponent(instance)}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        where: {
          id: `${normalizedIdentifier}@lid`
        }
      })
    });

    const body = await parseResponse(response);
    console.log('[contact-resolver] resposta:', JSON.stringify(body, null, 2));

    if (!response.ok) {
      console.log('[contact-resolver] nao foi possivel resolver LID, aceitando mensagem');
      return { phone: null, identifier: normalizedIdentifier, isLid: true };
    }

    const phone = findPhoneInResponse(body);

    if (!phone) {
      console.log('[contact-resolver] nao foi possivel resolver LID, aceitando mensagem');
      return { phone: null, identifier: normalizedIdentifier, isLid: true };
    }

    lidCache.set(normalizedIdentifier, phone);

    return {
      phone,
      identifier: normalizedIdentifier,
      isLid: true
    };
  } catch (error) {
    console.log('[contact-resolver] nao foi possivel resolver LID, aceitando mensagem', {
      message: error.message
    });

    return { phone: null, identifier: normalizedIdentifier, isLid: true };
  }
}
