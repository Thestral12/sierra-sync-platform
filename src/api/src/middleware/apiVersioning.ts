import { Request, Response, NextFunction } from 'express'
import { logger } from '../utils/logger'
import semver from 'semver'

interface ApiVersion {
  version: string
  deprecated?: boolean
  deprecationDate?: Date
  sunsetDate?: Date
  changes?: string[]
}

interface VersionConfig {
  current: string
  supported: ApiVersion[]
  defaultVersion: string
  headerName?: string
  queryParam?: string
  pathPrefix?: boolean
}

/**
 * API Versioning Service
 */
export class ApiVersioningService {
  private config: Required<VersionConfig>
  private versionHandlers: Map<string, Map<string, Function>> = new Map()
  
  constructor(config: VersionConfig) {
    this.config = {
      ...config,
      headerName: config.headerName || 'X-API-Version',
      queryParam: config.queryParam || 'api_version',
      pathPrefix: config.pathPrefix !== false
    }
    
    // Initialize version handlers map
    this.config.supported.forEach(v => {
      this.versionHandlers.set(v.version, new Map())
    })
  }
  
  /**
   * Extract version from request
   */
  extractVersion(req: Request): string {
    let version: string | undefined
    
    // 1. Check path prefix (e.g., /v1/users)
    if (this.config.pathPrefix) {
      const pathMatch = req.path.match(/^\/v(\d+(?:\.\d+)?(?:\.\d+)?)\//i)
      if (pathMatch) {
        version = pathMatch[1]
      }
    }
    
    // 2. Check header
    if (!version && this.config.headerName) {
      const headerValue = req.headers[this.config.headerName.toLowerCase()]
      if (headerValue) {
        version = Array.isArray(headerValue) ? headerValue[0] : headerValue
      }
    }
    
    // 3. Check query parameter
    if (!version && this.config.queryParam) {
      version = req.query[this.config.queryParam] as string
    }
    
    // 4. Check Accept header (e.g., application/vnd.api+json;version=1.0)
    if (!version) {
      const acceptHeader = req.headers.accept
      if (acceptHeader) {
        const versionMatch = acceptHeader.match(/version=(\d+(?:\.\d+)?(?:\.\d+)?)/i)
        if (versionMatch) {
          version = versionMatch[1]
        }
      }
    }
    
    // Use default version if none specified
    return version || this.config.defaultVersion
  }
  
  /**
   * Validate if version is supported
   */
  isVersionSupported(version: string): boolean {
    return this.config.supported.some(v => v.version === version)
  }
  
  /**
   * Get version info
   */
  getVersionInfo(version: string): ApiVersion | undefined {
    return this.config.supported.find(v => v.version === version)
  }
  
  /**
   * Check if version is deprecated
   */
  isVersionDeprecated(version: string): boolean {
    const versionInfo = this.getVersionInfo(version)
    return versionInfo?.deprecated === true
  }
  
  /**
   * Register version-specific handler
   */
  registerHandler(version: string, endpoint: string, handler: Function): void {
    const versionHandlers = this.versionHandlers.get(version)
    if (versionHandlers) {
      versionHandlers.set(endpoint, handler)
    }
  }
  
  /**
   * Get handler for specific version and endpoint
   */
  getHandler(version: string, endpoint: string): Function | undefined {
    return this.versionHandlers.get(version)?.get(endpoint)
  }
  
  /**
   * Middleware for API versioning
   */
  middleware() {
    return (req: Request & { apiVersion?: string }, res: Response, next: NextFunction) => {
      const version = this.extractVersion(req)
      
      // Check if version is supported
      if (!this.isVersionSupported(version)) {
        return res.status(400).json({
          error: 'Unsupported API version',
          message: `Version ${version} is not supported`,
          supportedVersions: this.config.supported.map(v => v.version),
          currentVersion: this.config.current
        })
      }
      
      // Store version in request
      req.apiVersion = version
      
      // Set version headers in response
      res.setHeader('X-API-Version', version)
      res.setHeader('X-API-Current-Version', this.config.current)
      
      // Add deprecation warning if applicable
      const versionInfo = this.getVersionInfo(version)
      if (versionInfo?.deprecated) {
        res.setHeader('X-API-Deprecated', 'true')
        
        if (versionInfo.sunsetDate) {
          res.setHeader('X-API-Sunset-Date', versionInfo.sunsetDate.toISOString())
        }
        
        if (versionInfo.deprecationDate) {
          res.setHeader('X-API-Deprecation-Date', versionInfo.deprecationDate.toISOString())
        }
        
        // Add deprecation warning to response
        res.setHeader(
          'Warning',
          `299 - "This API version is deprecated and will be sunset on ${versionInfo.sunsetDate?.toISOString() || 'TBD'}"`
        )
        
        logger.warn('Deprecated API version used', {
          version,
          endpoint: req.path,
          method: req.method,
          userId: (req as any).user?.id
        })
      }
      
      next()
    }
  }
  
  /**
   * Version-specific route handler
   */
  versionRoute(handlers: Record<string, Function>) {
    return (req: Request & { apiVersion?: string }, res: Response, next: NextFunction) => {
      const version = req.apiVersion || this.config.defaultVersion
      
      // Find matching handler for version
      const handler = handlers[version] || handlers.default
      
      if (!handler) {
        return res.status(501).json({
          error: 'Not implemented',
          message: `This endpoint is not available in API version ${version}`
        })
      }
      
      // Execute version-specific handler
      handler(req, res, next)
    }
  }
  
  /**
   * Transform response based on version
   */
  transformResponse(version: string, data: any): any {
    // Version-specific transformations
    const transformers: Record<string, (data: any) => any> = {
      '1.0': (data) => {
        // V1 format - legacy structure
        if (data.items) {
          return {
            data: data.items,
            count: data.total,
            page: data.page
          }
        }
        return data
      },
      '2.0': (data) => {
        // V2 format - new structure with metadata
        return {
          data: data.items || data,
          metadata: {
            total: data.total,
            page: data.page,
            limit: data.limit,
            hasMore: data.hasMore
          }
        }
      },
      '3.0': (data) => {
        // V3 format - includes links and relationships
        return {
          data: data.items || data,
          meta: {
            pagination: {
              total: data.total,
              page: data.page,
              limit: data.limit,
              pages: Math.ceil(data.total / data.limit)
            }
          },
          links: {
            self: data.links?.self,
            next: data.links?.next,
            prev: data.links?.prev,
            first: data.links?.first,
            last: data.links?.last
          }
        }
      }
    }
    
    const transformer = transformers[version]
    return transformer ? transformer(data) : data
  }
  
  /**
   * Get API changelog
   */
  getChangelog(): Record<string, string[]> {
    const changelog: Record<string, string[]> = {}
    
    this.config.supported.forEach(v => {
      if (v.changes) {
        changelog[v.version] = v.changes
      }
    })
    
    return changelog
  }
}

/**
 * Version compatibility checker
 */
export class VersionCompatibility {
  /**
   * Check if client version is compatible with server version
   */
  static isCompatible(clientVersion: string, serverVersion: string): boolean {
    // Use semver for compatibility checking
    return semver.satisfies(serverVersion, `^${clientVersion}`)
  }
  
  /**
   * Get migration guide between versions
   */
  static getMigrationGuide(fromVersion: string, toVersion: string): string[] {
    const guides: Record<string, string[]> = {
      '1.0->2.0': [
        'Response structure changed: "count" is now "metadata.total"',
        'Authentication endpoint moved from /auth to /v2/auth',
        'Date format changed from timestamp to ISO 8601',
        'Removed deprecated endpoints: /users/profile (use /users/me instead)'
      ],
      '2.0->3.0': [
        'Pagination links added to responses',
        'New required field "organizationId" in all requests',
        'Rate limiting headers format changed',
        'WebSocket endpoint changed from /ws to /v3/realtime'
      ]
    }
    
    const key = `${fromVersion}->${toVersion}`
    return guides[key] || [`No specific migration guide from ${fromVersion} to ${toVersion}`]
  }
  
  /**
   * Suggest upgrade path
   */
  static suggestUpgradePath(currentVersion: string, targetVersion: string): string[] {
    const versions = ['1.0', '2.0', '3.0']
    const currentIndex = versions.indexOf(currentVersion)
    const targetIndex = versions.indexOf(targetVersion)
    
    if (currentIndex === -1 || targetIndex === -1 || currentIndex >= targetIndex) {
      return []
    }
    
    return versions.slice(currentIndex, targetIndex + 1)
  }
}

/**
 * Create versioned routes
 */
export function createVersionedRoute(
  path: string,
  versions: Record<string, Function>
): Router {
  const router = require('express').Router()
  
  // Create route for each version
  Object.entries(versions).forEach(([version, handler]) => {
    if (version !== 'default') {
      router.all(`/v${version}${path}`, handler)
    }
  })
  
  // Default route (without version prefix)
  if (versions.default) {
    router.all(path, versions.default)
  }
  
  return router
}

/**
 * Version deprecation scheduler
 */
export class DeprecationScheduler {
  private timers: Map<string, NodeJS.Timeout> = new Map()
  
  /**
   * Schedule version deprecation
   */
  scheduleDeprecation(
    version: string,
    deprecationDate: Date,
    sunsetDate: Date,
    onDeprecate?: () => void,
    onSunset?: () => void
  ): void {
    // Schedule deprecation warning
    const deprecationDelay = deprecationDate.getTime() - Date.now()
    if (deprecationDelay > 0) {
      const deprecationTimer = setTimeout(() => {
        logger.warn(`API version ${version} is now deprecated`)
        onDeprecate?.()
      }, deprecationDelay)
      
      this.timers.set(`${version}-deprecation`, deprecationTimer)
    }
    
    // Schedule sunset
    const sunsetDelay = sunsetDate.getTime() - Date.now()
    if (sunsetDelay > 0) {
      const sunsetTimer = setTimeout(() => {
        logger.error(`API version ${version} has reached sunset`)
        onSunset?.()
      }, sunsetDelay)
      
      this.timers.set(`${version}-sunset`, sunsetTimer)
    }
  }
  
  /**
   * Cancel scheduled deprecation
   */
  cancelDeprecation(version: string): void {
    const deprecationTimer = this.timers.get(`${version}-deprecation`)
    const sunsetTimer = this.timers.get(`${version}-sunset`)
    
    if (deprecationTimer) {
      clearTimeout(deprecationTimer)
      this.timers.delete(`${version}-deprecation`)
    }
    
    if (sunsetTimer) {
      clearTimeout(sunsetTimer)
      this.timers.delete(`${version}-sunset`)
    }
  }
  
  /**
   * Clear all timers
   */
  clearAll(): void {
    this.timers.forEach(timer => clearTimeout(timer))
    this.timers.clear()
  }
}

/**
 * Initialize API versioning
 */
export function initializeApiVersioning(): ApiVersioningService {
  return new ApiVersioningService({
    current: '3.0',
    supported: [
      {
        version: '1.0',
        deprecated: true,
        deprecationDate: new Date('2024-01-01'),
        sunsetDate: new Date('2024-06-01'),
        changes: ['Legacy API version - please upgrade to v3.0']
      },
      {
        version: '2.0',
        deprecated: true,
        deprecationDate: new Date('2024-03-01'),
        sunsetDate: new Date('2024-09-01'),
        changes: ['Deprecated - missing latest features']
      },
      {
        version: '3.0',
        changes: [
          'Added webhook retry mechanism',
          'Improved error responses',
          'New field mapping endpoints',
          'GraphQL support'
        ]
      }
    ],
    defaultVersion: '3.0',
    headerName: 'X-API-Version',
    queryParam: 'api_version',
    pathPrefix: true
  })
}