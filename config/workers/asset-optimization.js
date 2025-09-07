// CloudFlare Worker for Sierra Sync Asset Optimization
// Handles intelligent asset delivery, compression, and caching

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  try {
    const url = new URL(request.url)
    const path = url.pathname
    
    // Only process static assets
    if (!path.startsWith('/static/')) {
      return fetch(request)
    }
    
    // Extract file extension and type
    const extension = path.split('.').pop()?.toLowerCase()
    const assetType = getAssetType(extension)
    
    // Check cache first
    const cache = caches.default
    const cacheKey = new Request(url.toString(), request)
    let response = await cache.match(cacheKey)
    
    if (response) {
      // Add cache hit header
      response = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: {
          ...response.headers,
          'CF-Cache-Status': 'HIT',
          'X-Worker-Cache': 'HIT'
        }
      })
      return response
    }
    
    // Fetch from origin (S3)
    const originRequest = optimizeOriginRequest(request, assetType)
    response = await fetch(originRequest)
    
    if (!response.ok) {
      return response
    }
    
    // Optimize response based on asset type
    const optimizedResponse = await optimizeAssetResponse(response, assetType, extension)
    
    // Cache the optimized response
    const cacheResponse = optimizedResponse.clone()
    await cache.put(cacheKey, cacheResponse)
    
    return optimizedResponse
    
  } catch (error) {
    console.error('Asset optimization error:', error)
    return new Response('Internal Server Error', { 
      status: 500,
      headers: { 'Content-Type': 'text/plain' }
    })
  }
}

function getAssetType(extension) {
  const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg']
  const fontExtensions = ['woff', 'woff2', 'ttf', 'eot', 'otf']
  const scriptExtensions = ['js', 'mjs']
  const styleExtensions = ['css']
  
  if (imageExtensions.includes(extension)) return 'image'
  if (fontExtensions.includes(extension)) return 'font'
  if (scriptExtensions.includes(extension)) return 'script'
  if (styleExtensions.includes(extension)) return 'style'
  
  return 'other'
}

function optimizeOriginRequest(request, assetType) {
  const url = new URL(request.url)
  
  // Add S3 bucket domain
  const s3Bucket = S3_BUCKET || 'sierra-sync-static-production'
  url.hostname = `${s3Bucket}.s3.amazonaws.com`
  
  // Add optimization headers
  const headers = new Headers(request.headers)
  
  // Request WebP for images if supported
  if (assetType === 'image') {
    const acceptHeader = request.headers.get('Accept') || ''
    if (acceptHeader.includes('image/webp')) {
      headers.set('X-Amz-Meta-Format-Preference', 'webp')
    }
  }
  
  // Add compression preference
  headers.set('Accept-Encoding', 'gzip, br')
  
  return new Request(url.toString(), {
    method: request.method,
    headers: headers,
    body: request.body
  })
}

async function optimizeAssetResponse(response, assetType, extension) {
  let body = response.body
  const headers = new Headers(response.headers)
  
  // Set appropriate cache headers
  setCacheHeaders(headers, assetType)
  
  // Set security headers
  setSecurityHeaders(headers, assetType)
  
  // Optimize based on asset type
  switch (assetType) {
    case 'image':
      return optimizeImageResponse(response, headers, extension)
      
    case 'font':
      return optimizeFontResponse(response, headers)
      
    case 'script':
      return optimizeScriptResponse(response, headers)
      
    case 'style':
      return optimizeStyleResponse(response, headers)
      
    default:
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: headers
      })
  }
}

function setCacheHeaders(headers, assetType) {
  // Remove any existing cache headers
  headers.delete('cache-control')
  headers.delete('expires')
  
  let maxAge
  switch (assetType) {
    case 'image':
      maxAge = 7776000 // 90 days
      break
    case 'font':
      maxAge = 31536000 // 1 year
      break
    case 'script':
    case 'style':
      maxAge = 604800 // 1 week
      break
    default:
      maxAge = 86400 // 1 day
  }
  
  headers.set('Cache-Control', `public, max-age=${maxAge}, immutable`)
  headers.set('CDN-Cache-Control', `public, max-age=${maxAge}`)
  
  // Add ETag for better caching
  const etag = `"${Date.now()}-${Math.random().toString(36).substr(2, 9)}"`
  headers.set('ETag', etag)
}

function setSecurityHeaders(headers, assetType) {
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('X-Frame-Options', 'DENY')
  headers.set('X-XSS-Protection', '1; mode=block')
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  
  // CORS headers for fonts and other cross-origin assets
  if (assetType === 'font') {
    headers.set('Access-Control-Allow-Origin', '*')
    headers.set('Access-Control-Allow-Methods', 'GET')
    headers.set('Access-Control-Max-Age', '86400')
  }
  
  // Worker identification
  headers.set('X-Served-By', 'sierra-sync-asset-worker')
  headers.set('X-Environment', ENVIRONMENT || 'production')
}

async function optimizeImageResponse(response, headers, extension) {
  // For now, just return with optimized headers
  // In the future, could add image resizing and format conversion
  headers.set('Content-Type', getImageContentType(extension))
  headers.set('X-Image-Optimized', 'true')
  
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: headers
  })
}

function optimizeFontResponse(response, headers) {
  // Add font-specific optimizations
  headers.set('X-Font-Optimized', 'true')
  
  // Font display optimization
  if (headers.get('content-type')?.includes('font')) {
    headers.set('Font-Display', 'swap')
  }
  
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: headers
  })
}

async function optimizeScriptResponse(response, headers) {
  const contentType = headers.get('content-type') || 'application/javascript'
  headers.set('Content-Type', contentType)
  headers.set('X-Script-Optimized', 'true')
  
  // Add source map support
  headers.set('SourceMap', 'true')
  
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: headers
  })
}

async function optimizeStyleResponse(response, headers) {
  headers.set('Content-Type', 'text/css')
  headers.set('X-Style-Optimized', 'true')
  
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: headers
  })
}

function getImageContentType(extension) {
  const mimeTypes = {
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'avif': 'image/avif',
    'svg': 'image/svg+xml'
  }
  
  return mimeTypes[extension] || 'image/jpeg'
}

// Handle different HTTP methods
async function handleNonGetRequest(request) {
  if (request.method === 'HEAD') {
    const getRequest = new Request(request.url, {
      method: 'GET',
      headers: request.headers
    })
    const response = await handleRequest(getRequest)
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    })
  }
  
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept, Accept-Encoding',
        'Access-Control-Max-Age': '86400'
      }
    })
  }
  
  return new Response('Method Not Allowed', { 
    status: 405,
    headers: { 'Allow': 'GET, HEAD, OPTIONS' }
  })
}