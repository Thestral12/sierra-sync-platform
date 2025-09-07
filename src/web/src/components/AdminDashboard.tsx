import React, { useState, useEffect } from 'react'
import {
  Users, Building2, Activity, AlertTriangle, TrendingUp, Database,
  Settings, Shield, Bell, Download, Upload, Webhook, CreditCard
} from 'lucide-react'

interface AdminStats {
  totalOrganizations: number
  totalUsers: number
  activeIntegrations: number
  syncEvents24h: number
  errorRate: number
  systemHealth: 'healthy' | 'degraded' | 'unhealthy'
  revenue: {
    mrr: number
    churn: number
    newSubscriptions: number
  }
  webhooks: {
    total: number
    successful: number
    failed: number
  }
  exports: {
    pending: number
    processing: number
    completed: number
  }
}

interface SystemAlert {
  id: string
  type: 'error' | 'warning' | 'info'
  title: string
  message: string
  timestamp: string
  resolved: boolean
}

const AdminDashboard: React.FC = () => {
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [alerts, setAlerts] = useState<SystemAlert[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedTab, setSelectedTab] = useState('overview')

  useEffect(() => {
    fetchDashboardData()
    const interval = setInterval(fetchDashboardData, 30000) // Refresh every 30 seconds
    return () => clearInterval(interval)
  }, [])

  const fetchDashboardData = async () => {
    try {
      const [statsResponse, alertsResponse] = await Promise.all([
        fetch('/api/admin/stats'),
        fetch('/api/admin/alerts')
      ])

      if (statsResponse.ok && alertsResponse.ok) {
        const [statsData, alertsData] = await Promise.all([
          statsResponse.json(),
          alertsResponse.json()
        ])
        setStats(statsData)
        setAlerts(alertsData.alerts)
      }
    } catch (error) {
      console.error('Failed to fetch dashboard data:', error)
    } finally {
      setLoading(false)
    }
  }

  const getHealthColor = (health: string) => {
    switch (health) {
      case 'healthy': return 'text-green-600 bg-green-100'
      case 'degraded': return 'text-yellow-600 bg-yellow-100'
      case 'unhealthy': return 'text-red-600 bg-red-100'
      default: return 'text-gray-600 bg-gray-100'
    }
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(amount)
  }

  const formatNumber = (num: number) => {
    return new Intl.NumberFormat('en-US').format(num)
  }

  const StatCard: React.FC<{
    title: string
    value: string | number
    icon: React.ReactNode
    trend?: number
    color?: string
  }> = ({ title, value, icon, trend, color = 'bg-blue-500' }) => (
    <div className="bg-white rounded-lg shadow-md p-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-600">{title}</p>
          <p className="text-2xl font-bold text-gray-900">{value}</p>
          {trend !== undefined && (
            <p className={`text-sm ${trend >= 0 ? 'text-green-600' : 'text-red-600'} flex items-center`}>
              <TrendingUp className="h-4 w-4 mr-1" />
              {trend >= 0 ? '+' : ''}{trend}%
            </p>
          )}
        </div>
        <div className={`p-3 rounded-full ${color}`}>
          <div className="text-white">
            {icon}
          </div>
        </div>
      </div>
    </div>
  )

  const AlertsList: React.FC = () => (
    <div className="bg-white rounded-lg shadow-md">
      <div className="px-6 py-4 border-b border-gray-200">
        <h3 className="text-lg font-medium text-gray-900">System Alerts</h3>
      </div>
      <div className="max-h-96 overflow-y-auto">
        {alerts.length === 0 ? (
          <div className="p-6 text-center text-gray-500">
            No active alerts
          </div>
        ) : (
          alerts.map((alert) => (
            <div key={alert.id} className={`p-4 border-b border-gray-100 ${alert.resolved ? 'opacity-50' : ''}`}>
              <div className="flex items-start">
                <div className={`flex-shrink-0 ${
                  alert.type === 'error' ? 'text-red-500' :
                  alert.type === 'warning' ? 'text-yellow-500' : 'text-blue-500'
                }`}>
                  <AlertTriangle className="h-5 w-5" />
                </div>
                <div className="ml-3 flex-1">
                  <p className="text-sm font-medium text-gray-900">{alert.title}</p>
                  <p className="text-sm text-gray-600">{alert.message}</p>
                  <p className="text-xs text-gray-400 mt-1">
                    {new Date(alert.timestamp).toLocaleString()}
                  </p>
                </div>
                {!alert.resolved && (
                  <button
                    onClick={() => resolveAlert(alert.id)}
                    className="ml-2 text-sm text-blue-600 hover:text-blue-800"
                  >
                    Resolve
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )

  const resolveAlert = async (alertId: string) => {
    try {
      const response = await fetch(`/api/admin/alerts/${alertId}/resolve`, {
        method: 'POST'
      })
      
      if (response.ok) {
        setAlerts(alerts.map(alert => 
          alert.id === alertId ? { ...alert, resolved: true } : alert
        ))
      }
    } catch (error) {
      console.error('Failed to resolve alert:', error)
    }
  }

  const OrganizationsList: React.FC = () => {
    const [organizations, setOrganizations] = useState([])
    const [loadingOrgs, setLoadingOrgs] = useState(true)

    useEffect(() => {
      fetchOrganizations()
    }, [])

    const fetchOrganizations = async () => {
      try {
        const response = await fetch('/api/admin/organizations')
        if (response.ok) {
          const data = await response.json()
          setOrganizations(data.organizations)
        }
      } catch (error) {
        console.error('Failed to fetch organizations:', error)
      } finally {
        setLoadingOrgs(false)
      }
    }

    if (loadingOrgs) {
      return <div className="p-6 text-center">Loading organizations...</div>
    }

    return (
      <div className="bg-white rounded-lg shadow-md">
        <div className="px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-medium text-gray-900">Organizations</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Organization
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Users
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Plan
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {organizations.map((org: any) => (
                <tr key={org.id}>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center">
                      <Building2 className="h-5 w-5 text-gray-400 mr-3" />
                      <div>
                        <div className="text-sm font-medium text-gray-900">{org.name}</div>
                        <div className="text-sm text-gray-500">{org.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {org.userCount}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`px-2 py-1 text-xs rounded-full ${
                      org.plan === 'enterprise' ? 'bg-purple-100 text-purple-800' :
                      org.plan === 'pro' ? 'bg-blue-100 text-blue-800' :
                      'bg-gray-100 text-gray-800'
                    }`}>
                      {org.plan}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`px-2 py-1 text-xs rounded-full ${
                      org.status === 'active' ? 'bg-green-100 text-green-800' :
                      org.status === 'suspended' ? 'bg-red-100 text-red-800' :
                      'bg-yellow-100 text-yellow-800'
                    }`}>
                      {org.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                    <button className="text-blue-600 hover:text-blue-900 mr-2">View</button>
                    <button className="text-green-600 hover:text-green-900 mr-2">Edit</button>
                    <button className="text-red-600 hover:text-red-900">Suspend</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  const SystemMonitoring: React.FC = () => (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="bg-white rounded-lg shadow-md p-6">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Service Health</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">API Server</span>
            <span className="px-2 py-1 text-xs rounded-full bg-green-100 text-green-800">
              Healthy
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">Database</span>
            <span className="px-2 py-1 text-xs rounded-full bg-green-100 text-green-800">
              Healthy
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">Redis Cache</span>
            <span className="px-2 py-1 text-xs rounded-full bg-yellow-100 text-yellow-800">
              Degraded
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">Webhook Service</span>
            <span className="px-2 py-1 text-xs rounded-full bg-green-100 text-green-800">
              Healthy
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">Export Service</span>
            <span className="px-2 py-1 text-xs rounded-full bg-green-100 text-green-800">
              Healthy
            </span>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md p-6">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Resource Usage</h3>
        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm text-gray-600">CPU Usage</span>
              <span className="text-sm text-gray-900">45%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div className="bg-blue-600 h-2 rounded-full" style={{ width: '45%' }}></div>
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm text-gray-600">Memory Usage</span>
              <span className="text-sm text-gray-900">72%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div className="bg-yellow-600 h-2 rounded-full" style={{ width: '72%' }}></div>
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm text-gray-600">Disk Usage</span>
              <span className="text-sm text-gray-900">28%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div className="bg-green-600 h-2 rounded-full" style={{ width: '28%' }}></div>
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm text-gray-600">Network I/O</span>
              <span className="text-sm text-gray-900">156 MB/s</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div className="bg-purple-600 h-2 rounded-full" style={{ width: '65%' }}></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )

  const tabs = [
    { id: 'overview', name: 'Overview', icon: Activity },
    { id: 'organizations', name: 'Organizations', icon: Building2 },
    { id: 'monitoring', name: 'Monitoring', icon: Shield },
    { id: 'settings', name: 'Settings', icon: Settings }
  ]

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-blue-600"></div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-6">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Admin Dashboard</h1>
              <p className="text-sm text-gray-600">System overview and management</p>
            </div>
            <div className="flex items-center space-x-4">
              <span className={`px-3 py-1 rounded-full text-sm font-medium ${getHealthColor(stats?.systemHealth || 'unhealthy')}`}>
                {stats?.systemHealth?.charAt(0).toUpperCase() + stats?.systemHealth?.slice(1)}
              </span>
              <Bell className="h-6 w-6 text-gray-400" />
            </div>
          </div>
          
          {/* Tabs */}
          <div className="border-b border-gray-200">
            <nav className="-mb-px flex space-x-8">
              {tabs.map((tab) => {
                const Icon = tab.icon
                return (
                  <button
                    key={tab.id}
                    onClick={() => setSelectedTab(tab.id)}
                    className={`${
                      selectedTab === tab.id
                        ? 'border-blue-500 text-blue-600'
                        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                    } whitespace-nowrap py-2 px-1 border-b-2 font-medium text-sm flex items-center`}
                  >
                    <Icon className="h-4 w-4 mr-2" />
                    {tab.name}
                  </button>
                )
              })}
            </nav>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {selectedTab === 'overview' && (
          <div className="space-y-8">
            {/* Stats Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              <StatCard
                title="Total Organizations"
                value={formatNumber(stats?.totalOrganizations || 0)}
                icon={<Building2 className="h-6 w-6" />}
                trend={5.2}
              />
              <StatCard
                title="Total Users"
                value={formatNumber(stats?.totalUsers || 0)}
                icon={<Users className="h-6 w-6" />}
                trend={12.3}
                color="bg-green-500"
              />
              <StatCard
                title="Active Integrations"
                value={formatNumber(stats?.activeIntegrations || 0)}
                icon={<Activity className="h-6 w-6" />}
                trend={-2.1}
                color="bg-purple-500"
              />
              <StatCard
                title="Sync Events (24h)"
                value={formatNumber(stats?.syncEvents24h || 0)}
                icon={<Database className="h-6 w-6" />}
                trend={18.7}
                color="bg-yellow-500"
              />
            </div>

            {/* Revenue and Webhook Stats */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <StatCard
                title="Monthly Recurring Revenue"
                value={formatCurrency(stats?.revenue.mrr || 0)}
                icon={<CreditCard className="h-6 w-6" />}
                trend={8.5}
                color="bg-green-600"
              />
              <StatCard
                title="Webhook Success Rate"
                value={`${Math.round((stats?.webhooks.successful || 0) / Math.max((stats?.webhooks.total || 1), 1) * 100)}%`}
                icon={<Webhook className="h-6 w-6" />}
                color="bg-blue-600"
              />
              <StatCard
                title="Export Queue"
                value={`${stats?.exports.pending || 0} pending`}
                icon={<Download className="h-6 w-6" />}
                color="bg-indigo-600"
              />
            </div>

            {/* Alerts */}
            <AlertsList />
          </div>
        )}

        {selectedTab === 'organizations' && <OrganizationsList />}
        
        {selectedTab === 'monitoring' && <SystemMonitoring />}
        
        {selectedTab === 'settings' && (
          <div className="bg-white rounded-lg shadow-md p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">System Settings</h3>
            <p className="text-gray-600">System configuration settings will be implemented here.</p>
          </div>
        )}
      </div>
    </div>
  )
}

export default AdminDashboard