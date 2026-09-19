import axios from 'axios'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '/api' : 'http://localhost:3001/api')
})

// Add JWT token to all requests
api.interceptors.request.use(config => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
}, error => {
  return Promise.reject(error)
})

// Handle 401 responses — session expired
api.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 401 && localStorage.getItem('token')) {
      // Clear auth state
      localStorage.removeItem('token')
      localStorage.removeItem('admin_token')
      // Redirect to login with message (avoid infinite loop by checking current path)
      if (window.location.pathname !== '/login' && window.location.pathname !== '/submit') {
        window.location.href = '/login?expired=1'
      }
    }
    return Promise.reject(error)
  }
)

export default api
