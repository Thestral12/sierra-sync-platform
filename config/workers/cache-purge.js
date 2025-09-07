// CloudFlare Worker for Sierra Sync Cache Purge Webhook
// Handles automated cache invalidation on deployments

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  try {
    // Only handle POST requests
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: {
          'Allow': 'POST',
          'Content-Type': 'application/json'
        }
      })
    }
    
    // Verify webhook signature
    const signature = request.headers.get('X-Webhook-Signature')
    if (!await verifyWebhookSignature(request, signature)) {
      return new Response(JSON.stringify({
        error: 'Invalid webhook signature'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    
    // Parse request body
    const body = await request.json()
    const { action, paths, tags, environment } = body
    
    // Validate required fields
    if (!action || !environment) {
      return new Response(JSON.stringify({
        error: 'Missing required fields: action, environment'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    
    // Handle different purge actions
    let result
    switch (action) {
      case 'purge_files':
        result = await purgeFiles(paths || [])
        break
        
      case 'purge_tags':
        result = await purgeTags(tags || [])
        break
        
      case 'purge_all':
        result = await purgeAll()
        break
        
      case 'purge_css_js':
        result = await purgeCssJs()
        break
        
      case 'purge_images':
        result = await purgeImages()
        break
        
      default:
        return new Response(JSON.stringify({
          error: `Unknown action: ${action}`
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        })
    }
    
    // Log the purge operation
    console.log('Cache purge completed', {
      action,
      environment,
      paths: paths?.length || 0,
      tags: tags?.length || 0,
      success: result.success
    })
    
    return new Response(JSON.stringify({
      success: result.success,
      message: result.message,
      purged_urls: result.purgedUrls || [],
      timestamp: new Date().toISOString(),
      action,
      environment
    }), {
      status: result.success ? 200 : 500,
      headers: { 'Content-Type': 'application/json' }
    })
    
  } catch (error) {
    console.error('Cache purge webhook error:', error)
    
    return new Response(JSON.stringify({
      success: false,
      error: 'Internal server error',
      message: error.message,
      timestamp: new Date().toISOString()
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

async function verifyWebhookSignature(request, signature) {
  if (!signature || !WEBHOOK_SECRET) {
    return false
  }
  
  try {
    const body = await request.clone().text()
    const encoder = new TextEncoder()
    const data = encoder.encode(body)
    const key = encoder.encode(WEBHOOK_SECRET)
    
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      key,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
    
    const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, data)
    const computedSignature = Array.from(new Uint8Array(signatureBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
    
    const expectedSignature = `sha256=${computedSignature}`
    
    // Constant time comparison
    return constantTimeCompare(signature, expectedSignature)
    
  } catch (error) {
    console.error('Signature verification error:', error)
    return false
  }
}

function constantTimeCompare(a, b) {
  if (a.length !== b.length) {
    return false
  }
  
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  
  return result === 0
}

async function purgeFiles(paths) {
  if (!paths || paths.length === 0) {
    return {
      success: false,
      message: 'No file paths provided'
    }
  }
  
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/purge_cache`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CF_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        files: paths
      })
    })
    
    const result = await response.json()
    
    if (result.success) {
      return {
        success: true,
        message: `Successfully purged ${paths.length} files`,
        purgedUrls: paths
      }
    } else {
      return {
        success: false,
        message: `Purge failed: ${result.errors?.[0]?.message || 'Unknown error'}`
      }
    }
    
  } catch (error) {
    return {
      success: false,
      message: `Purge request failed: ${error.message}`
    }
  }
}

async function purgeTags(tags) {
  if (!tags || tags.length === 0) {
    return {
      success: false,
      message: 'No cache tags provided'
    }
  }
  
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/purge_cache`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CF_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        tags: tags
      })
    })
    
    const result = await response.json()
    
    if (result.success) {
      return {
        success: true,
        message: `Successfully purged cache for ${tags.length} tags`,
        purgedUrls: tags
      }
    } else {
      return {
        success: false,
        message: `Tag purge failed: ${result.errors?.[0]?.message || 'Unknown error'}`
      }
    }
    
  } catch (error) {
    return {
      success: false,
      message: `Tag purge request failed: ${error.message}`
    }
  }
}

async function purgeAll() {
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/purge_cache`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CF_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        purge_everything: true
      })
    })
    
    const result = await response.json()
    
    if (result.success) {
      return {
        success: true,
        message: 'Successfully purged all cache'
      }
    } else {
      return {
        success: false,
        message: `Full purge failed: ${result.errors?.[0]?.message || 'Unknown error'}`
      }
    }
    
  } catch (error) {
    return {
      success: false,
      message: `Full purge request failed: ${error.message}`
    }
  }
}

async function purgeCssJs() {
  const paths = [
    'https://sierrasync.com/static/css/*',
    'https://sierrasync.com/static/js/*',
    'https://static.sierrasync.com/css/*',
    'https://static.sierrasync.com/js/*'
  ]
  
  return await purgeFiles(paths)
}

async function purgeImages() {
  const paths = [
    'https://sierrasync.com/static/images/*',
    'https://static.sierrasync.com/images/*',
    'https://cdn.sierrasync.com/images/*'
  ]
  
  return await purgeFiles(paths)
}

// Handle preflight requests
function handlePreflight(request) {
  const headers = request.headers
  
  if (
    headers.get('Origin') !== null &&
    headers.get('Access-Control-Request-Method') !== null &&
    headers.get('Access-Control-Request-Headers') !== null
  ) {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Webhook-Signature',
        'Access-Control-Max-Age': '86400'
      }
    })
  }
  
  return new Response(null, {
    status: 405,
    statusText: 'Method Not Allowed'
  })
}

// Webhook payload examples:
/*
{
  "action": "purge_files",
  "paths": [
    "https://sierrasync.com/static/css/main.css",
    "https://sierrasync.com/static/js/app.js"
  ],
  "environment": "production"
}

{
  "action": "purge_tags",
  "tags": ["css", "js", "deployment-v1.2.3"],
  "environment": "production"
}

{
  "action": "purge_all",
  "environment": "production"
}

{
  "action": "purge_css_js",
  "environment": "production"
}

{
  "action": "purge_images",
  "environment": "production"
}
*/