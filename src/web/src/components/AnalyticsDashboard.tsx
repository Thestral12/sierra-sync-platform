import React, { useState, useEffect } from 'react'
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts'
import {
  TrendingUp, TrendingDown, Users, Activity, Target,
  Calendar, Filter, Download, Refresh, Plus, Settings
} from 'lucide-react'

interface MetricCardProps {
  title: string
  value: string | number
  change?: number
  icon: React.ReactNode
  color?: string
}

interface ChartData {
  labels: string[]
  datasets: Array<{
    label: string
    data: number[]
    color: string
  }>
}

interface BusinessMetrics {
  overview: {
    totalUsers: number
    activeUsers: number
    totalLeads: number
    syncSuccessRate: number
  }
  growth: {
    userGrowth: {
      data: Record<string, number>
      growthRate: number
    }
    leadGrowth: {
      data: Record<string, number>
      growthRate: number
    }
  }
  engagement: {
    dailyActiveUsers: Record<string, number>
    averageSessionDuration: number
    featureUsage: Record<string, number>
  }
  conversion: {
    leadConversion: {
      total: number
      converted: number
      rate: number
    }
    syncSuccessRates: Record<string, number>
  }
}

const AnalyticsDashboard: React.FC = () => {
  const [metrics, setMetrics] = useState<BusinessMetrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [timeRange, setTimeRange] = useState('last_30_days')
  const [refreshing, setRefreshing] = useState(false)
  const [selectedTab, setSelectedTab] = useState('overview')

  useEffect(() => {
    fetchMetrics()
    const interval = setInterval(fetchMetrics, 300000) // Refresh every 5 minutes
    return () => clearInterval(interval)
  }, [timeRange])

  const fetchMetrics = async () => {
    try {
      setRefreshing(true)
      
      const endDate = new Date()
      const startDate = new Date()
      
      switch (timeRange) {
        case 'last_7_days':
          startDate.setDate(endDate.getDate() - 7)
          break
        case 'last_30_days':
          startDate.setDate(endDate.getDate() - 30)
          break
        case 'last_90_days':
          startDate.setDate(endDate.getDate() - 90)
          break
        default:
          startDate.setDate(endDate.getDate() - 30)
      }

      const response = await fetch(
        `/api/analytics/business-metrics?start=${startDate.toISOString()}&end=${endDate.toISOString()}`
      )
      
      if (response.ok) {
        const data = await response.json()
        setMetrics(data.data)
      }
    } catch (error) {
      console.error('Failed to fetch metrics:', error)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  const formatNumber = (num: number) => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`
    return num.toString()
  }

  const formatPercentage = (num: number) => {
    return `${Math.round(num * 100) / 100}%`
  }

  const MetricCard: React.FC<MetricCardProps> = ({ title, value, change, icon, color = 'bg-blue-500' }) => (
    <div className="bg-white rounded-lg shadow-md p-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-600">{title}</p>
          <p className="text-2xl font-bold text-gray-900">{value}</p>
          {change !== undefined && (
            <p className={`text-sm flex items-center mt-1 ${
              change >= 0 ? 'text-green-600' : 'text-red-600'
            }`}>
              {change >= 0 ? <TrendingUp className="h-4 w-4 mr-1" /> : <TrendingDown className="h-4 w-4 mr-1" />}
              {change >= 0 ? '+' : ''}{formatPercentage(change)}
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

  const OverviewTab: React.FC = () => {
    if (!metrics) return null

    const { overview, growth } = metrics

    const userGrowthData = Object.entries(growth.userGrowth.data).map(([date, value]) => ({
      date: new Date(date).toLocaleDateString(),
      users: value
    }))

    const leadGrowthData = Object.entries(growth.leadGrowth.data).map(([date, value]) => ({
      date: new Date(date).toLocaleDateString(),
      leads: value
    }))

    return (
      <div className="space-y-6">
        {/* Metric Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <MetricCard
            title="Total Users"
            value={formatNumber(overview.totalUsers)}
            change={growth.userGrowth.growthRate}
            icon={<Users className="h-6 w-6" />}
            color="bg-blue-500"
          />
          <MetricCard
            title="Active Users"
            value={formatNumber(overview.activeUsers)}
            icon={<Activity className="h-6 w-6" />}
            color="bg-green-500"
          />
          <MetricCard
            title="Total Leads"
            value={formatNumber(overview.totalLeads)}
            change={growth.leadGrowth.growthRate}
            icon={<Target className="h-6 w-6" />}
            color="bg-purple-500"
          />
          <MetricCard
            title="Sync Success Rate"
            value={formatPercentage(overview.syncSuccessRate)}
            icon={<TrendingUp className="h-6 w-6" />}
            color="bg-orange-500"
          />
        </div>

        {/* Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white rounded-lg shadow-md p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">User Growth</h3>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={userGrowthData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip />
                <Line type="monotone" dataKey="users" stroke="#3B82F6" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="bg-white rounded-lg shadow-md p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Lead Growth</h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={leadGrowthData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip />
                <Bar dataKey="leads" fill="#10B981" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    )
  }

  const EngagementTab: React.FC = () => {
    if (!metrics) return null

    const { engagement } = metrics

    const dauData = Object.entries(engagement.dailyActiveUsers).map(([date, value]) => ({
      date: new Date(date).toLocaleDateString(),
      activeUsers: value
    }))

    const featureUsageData = Object.entries(engagement.featureUsage).map(([feature, usage]) => ({
      feature,
      usage,
      color: `hsl(${Math.random() * 360}, 70%, 50%)`
    }))

    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <MetricCard
            title="Avg Session Duration"
            value={`${Math.round(engagement.averageSessionDuration)}min`}
            icon={<Activity className="h-6 w-6" />}
            color="bg-indigo-500"
          />
          <MetricCard
            title="Daily Active Users"
            value={formatNumber(Object.values(engagement.dailyActiveUsers).reduce((a, b) => Math.max(a, b), 0))}
            icon={<Users className="h-6 w-6" />}
            color="bg-pink-500"
          />
          <MetricCard
            title="Feature Usage Events"
            value={formatNumber(Object.values(engagement.featureUsage).reduce((a, b) => a + b, 0))}
            icon={<Target className="h-6 w-6" />}
            color="bg-cyan-500"
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white rounded-lg shadow-md p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Daily Active Users</h3>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={dauData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip />
                <Line type="monotone" dataKey="activeUsers" stroke="#8B5CF6" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="bg-white rounded-lg shadow-md p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Feature Usage</h3>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={featureUsageData}
                  dataKey="usage"
                  nameKey="feature"
                  cx="50%"
                  cy="50%"
                  outerRadius={100}
                  label={({ feature, percent }) => `${feature}: ${(percent * 100).toFixed(1)}%`}
                >
                  {featureUsageData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    )
  }

  const ConversionTab: React.FC = () => {
    if (!metrics) return null

    const { conversion } = metrics

    const syncRateData = Object.entries(conversion.syncSuccessRates).map(([crm, rate]) => ({
      crm: crm.toUpperCase(),
      rate: Math.round(rate * 100) / 100
    }))

    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <MetricCard
            title="Lead Conversion Rate"
            value={formatPercentage(conversion.leadConversion.rate)}
            icon={<Target className="h-6 w-6" />}
            color="bg-emerald-500"
          />
          <MetricCard
            title="Converted Leads"
            value={formatNumber(conversion.leadConversion.converted)}
            icon={<TrendingUp className="h-6 w-6" />}
            color="bg-blue-500"
          />
          <MetricCard
            title="Total Leads"
            value={formatNumber(conversion.leadConversion.total)}
            icon={<Users className="h-6 w-6" />}
            color="bg-gray-500"
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white rounded-lg shadow-md p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Sync Success Rates by CRM</h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={syncRateData} layout="horizontal">
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" domain={[0, 100]} />
                <YAxis dataKey="crm" type="category" />
                <Tooltip formatter={(value) => [`${value}%`, 'Success Rate']} />
                <Bar dataKey="rate" fill="#F59E0B" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="bg-white rounded-lg shadow-md p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Conversion Funnel</h3>
            <div className="space-y-4">
              <div className="flex items-center justify-between p-4 bg-blue-50 rounded-lg">
                <span className="font-medium">Total Leads</span>
                <span className="text-lg font-bold text-blue-600">
                  {formatNumber(conversion.leadConversion.total)}
                </span>
              </div>
              <div className="flex items-center justify-between p-4 bg-green-50 rounded-lg">
                <span className="font-medium">Converted Leads</span>
                <span className="text-lg font-bold text-green-600">
                  {formatNumber(conversion.leadConversion.converted)}
                </span>
              </div>
              <div className="flex items-center justify-between p-4 bg-purple-50 rounded-lg">
                <span className="font-medium">Conversion Rate</span>
                <span className="text-lg font-bold text-purple-600">
                  {formatPercentage(conversion.leadConversion.rate)}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const tabs = [
    { id: 'overview', name: 'Overview', icon: Activity },
    { id: 'engagement', name: 'Engagement', icon: Users },
    { id: 'conversion', name: 'Conversion', icon: Target }
  ]

  if (loading && !metrics) {
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
              <h1 className="text-2xl font-bold text-gray-900">Analytics Dashboard</h1>
              <p className="text-sm text-gray-600">Real-time insights and metrics</p>
            </div>
            
            <div className="flex items-center space-x-4">
              {/* Time Range Selector */}
              <select
                value={timeRange}
                onChange={(e) => setTimeRange(e.target.value)}
                className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="last_7_days">Last 7 days</option>
                <option value="last_30_days">Last 30 days</option>
                <option value="last_90_days">Last 90 days</option>
              </select>
              
              {/* Action Buttons */}
              <button
                onClick={fetchMetrics}
                disabled={refreshing}
                className="flex items-center px-3 py-2 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <Refresh className={`h-4 w-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
                Refresh
              </button>
              
              <button className="flex items-center px-3 py-2 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500">
                <Download className="h-4 w-4 mr-2" />
                Export
              </button>
              
              <button className="flex items-center px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500">
                <Plus className="h-4 w-4 mr-2" />
                Create Dashboard
              </button>
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
        {selectedTab === 'overview' && <OverviewTab />}
        {selectedTab === 'engagement' && <EngagementTab />}
        {selectedTab === 'conversion' && <ConversionTab />}
      </div>
    </div>
  )
}

export default AnalyticsDashboard