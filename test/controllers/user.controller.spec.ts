/*
 * This file is part of CabasVert.
 *
 * Copyright 2017, 2018 Didier Villevalois
 *
 * CabasVert is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * CabasVert is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with CabasVert.  If not, see <http://www.gnu.org/licenses/>.
 */

import * as http from 'http'
import { Container } from 'inversify'
import 'jasmine'
import * as Mail from 'nodemailer/lib/mailer'
import 'reflect-metadata'
import * as winston from 'winston'
import { LoggerInstance } from 'winston'

import { Configuration, defaultConfiguration } from '../../src/config'

import '../../src/controllers/user.controller'

import { User, UserMetadata } from '../../src/models/user.model'
import { initializeServer } from '../../src/server'
import { DatabaseService } from '../../src/services/database.service'
import { MailService } from '../../src/services/mail.service'
import { TokenService } from '../../src/services/token.service'
import { Services } from '../../src/types'

const request = require('supertest')

type UserWithPassword = User & { password?: string }

const fakeUserId = 'john.doe@example.com'
const wrongUserId = 'jane.smith@example.com'

class DatabaseServiceMock extends DatabaseService {

  private _users: { [id: string]: UserWithPassword }
  private failing: boolean

  reset() {
    this._users = {}
    this._users[fakeUserId] = {
      name: fakeUserId,
      roles: [],
      metadata: {
        name: 'John Doe',
        email: fakeUserId,
      },
      password: 'password',
    }
    this.failing = false
  }

  async initialize() {
    if (this.failing) throw new Error('Database failed')
  }

  async logIn() {
    if (this.failing) throw new Error('Database failed')
  }

  async logOut() {
  }

  async getUser(userId: string): Promise<UserWithPassword> {
    if (this.failing) throw new Error('Database failed')

    return this._users[userId]
  }

  async updateUser(userId: string, data: { metadata: UserMetadata }): Promise<any> {
    if (this.failing) throw new Error('Database failed')

    this._users[userId].metadata = data.metadata
    return { ok: true }
  }

  async changePassword(userId: string, password: string): Promise<boolean> {
    if (this.failing) throw new Error('Database failed')

    this._users[userId].password = password
    return true
  }

  setFailing(failing: boolean) {
    this.failing = failing
  }
}

class TokenServiceMock extends TokenService {

  async generateToken(): Promise<{ token: string, hash: string }> {
    return { token: 'fake-token', hash: 'fake-hash' }
  }

  async hashToken(token: string): Promise<string> {
    return token === 'fake-token' ? 'fake-hash' : 'some-other-hash'
  }
}

class MailServiceMock extends MailService {

  public sentMail: Mail.Options
  private failing: boolean

  reset() {
    this.sentMail = null
    this.failing = false
  }

  async sendMail(mail: Mail.Options) {
    if (this.failing) throw new Error('Email sending failed')

    this.sentMail = mail
    return {}
  }

  setFailing(failing: boolean) {
    this.failing = failing
  }
}

describe('UserController', () => {

  let configuration = defaultConfiguration()

  let nullLogger = new winston.Logger({})
  let databaseServiceMock = new DatabaseServiceMock(configuration, nullLogger)
  let tokenServiceMock = new TokenServiceMock()
  let mailServiceMock = new MailServiceMock(configuration, nullLogger)

  let server: http.Server

  beforeEach(async () => {
    databaseServiceMock.reset()
    mailServiceMock.reset()

    // load everything needed to the Container
    let container = new Container()

    container.bind<Configuration>(Services.Config).toConstantValue(configuration)
    container.bind<LoggerInstance>(Services.Logger).toConstantValue(nullLogger)
    container.bind<DatabaseService>(Services.Database).toConstantValue(databaseServiceMock)
    container.bind<MailService>(Services.Mail).toConstantValue(mailServiceMock)
    container.bind<TokenService>(Services.Token).toConstantValue(tokenServiceMock)

    server = await initializeServer(Promise.resolve(container))
  })

  afterEach(async () => {
    server.close()
  })

  it('correctly resets password', async () => {
    await request(server)
      .get('/api/user/request-password-reset/' + fakeUserId)
      .expect(200)
      .expect('Content-Type', 'application/json; charset=utf-8')
      .expect({ ok: true })

    expect(mailServiceMock.sentMail.to).toContain(fakeUserId)
    let baseUrl = configuration.clientApplication.url
    expect(mailServiceMock.sentMail.text).toContain(
      `${baseUrl}/#/reset-password/${fakeUserId}/fake-token`)

    let user = await databaseServiceMock.getUser(fakeUserId)
    let prt = user.metadata['password-reset-token']
    expect(prt).not.toBeNull()
    expect(prt.hash).toEqual('fake-hash')

    await request(server)
      .post('/api/user/confirm-password-reset')
      .send({
        'username': fakeUserId,
        'token': 'fake-token',
        'new-password': 'newPassword',
      })
      .expect(200)
      .expect('Content-Type', 'application/json; charset=utf-8')
      .expect({ ok: true })

    user = await databaseServiceMock.getUser(fakeUserId)
    expect(user.password).toBe('newPassword')
  })

  it('does not store token if mail sending failed', async () => {
    mailServiceMock.setFailing(true)

    await request(server)
      .get('/api/user/request-password-reset/' + fakeUserId)
      .expect(500)
      .expect('Content-Type', 'application/json; charset=utf-8')
      .expect({ ok: false, error: 'Email sending failed' })

    let user = await databaseServiceMock.getUser(fakeUserId)
    let prt = user.metadata['password-reset-token']
    expect(prt).toBeUndefined()
  })

  it('rejects confirmations with invalid token', async () => {
    await testRequestConfirmFailure(
      fakeUserId,
      {
        'username': fakeUserId,
        'token': 'invalid-token',
        'new-password': 'newPassword',
      },
      'Token is invalid',
      true,
    )
  })

  it('rejects confirmations with expired token', async () => {
    await testRequestConfirmFailure(
      fakeUserId,
      {
        'username': fakeUserId,
        'token': 'invalid-token',
        'new-password': 'newPassword',
      },
      'Token has expired',
      true,
      async () => {
        // Tamper with token's expiry date !
        let user = await databaseServiceMock.getUser(fakeUserId)
        user.metadata['password-reset-token'].expiryDate = new Date().toISOString()
        await databaseServiceMock.updateUser(fakeUserId, user)
      },
    )
  })

  it('rejects confirmations with missing username data', async () => {
    await testRequestConfirmFailure(
      fakeUserId,
      {
        'token': 'invalid-token',
        'new-password': 'newPassword',
      },
      'Missing data for password reset',
    )
  })

  it('rejects confirmations with missing token data', async () => {
    await testRequestConfirmFailure(
      fakeUserId,
      {
        'username': fakeUserId,
        'new-password': 'newPassword',
      },
      'Missing data for password reset',
    )
  })

  it('rejects confirmations with missing new-password data', async () => {
    await testRequestConfirmFailure(
      fakeUserId,
      {
        'username': fakeUserId,
        'token': 'invalid-token',
      },
      'Missing data for password reset',
    )
  })

  let noop: () => Promise<void> = async () => {
  }

  async function testRequestConfirmFailure(userId: string,
                                           confirmData: any,
                                           errorMessage: string,
                                           testTokenHasBeenCleared: boolean = false,
                                           beforeConfirm: () => Promise<void> = noop) {
    await request(server)
      .get('/api/user/request-password-reset/' + userId)
      .expect(200)
      .expect('Content-Type', 'application/json; charset=utf-8')
      .expect({ ok: true })

    await beforeConfirm()

    await request(server)
      .post('/api/user/confirm-password-reset')
      .send(confirmData)
      .expect(400)
      .expect('Content-Type', 'application/json; charset=utf-8')
      .expect({ ok: false, error: errorMessage })

    let user = await databaseServiceMock.getUser(userId)
    expect(user.password).toBe('password')
    if (testTokenHasBeenCleared) {
      let prt = user.metadata['password-reset-token']
      expect(prt).toBeUndefined()
    }
  }

  it('rejects requests for unknown users', async () => {
    await request(server)
      .get('/api/user/request-password-reset/' + wrongUserId)
      .expect(400)
      .expect('Content-Type', 'application/json; charset=utf-8')
      .expect({ ok: false, error: 'Unknown user' })
  })

  it('rejects confirmations for unknown users', async () => {
    await request(server)
      .post('/api/user/confirm-password-reset')
      .send({
        'username': wrongUserId,
        'token': 'fake-token',
        'new-password': 'newPassword',
      })
      .expect(400)
      .expect('Content-Type', 'application/json; charset=utf-8')
      .expect({ ok: false, error: 'Unknown user' })
  })

  it('rejects confirmations without prior request', async () => {
    await request(server)
      .post('/api/user/confirm-password-reset')
      .send({
        'username': fakeUserId,
        'token': 'fake-token',
        'new-password': 'newPassword',
      })
      .expect(400)
      .expect('Content-Type', 'application/json; charset=utf-8')
      .expect({ ok: false, error: 'No password reset request done' })
  })

  it('errors requests if database fails', async () => {
    databaseServiceMock.setFailing(true)

    await request(server)
      .get('/api/user/request-password-reset/' + fakeUserId)
      .expect(500)
      .expect('Content-Type', 'application/json; charset=utf-8')
      .expect({ ok: false, error: 'Database failed' })
  })

  it('errors confirmations if database fails', async () => {
    databaseServiceMock.setFailing(true)

    await request(server)
      .post('/api/user/confirm-password-reset')
      .send({
        'username': fakeUserId,
        'token': 'fake-token',
        'new-password': 'newPassword',
      })
      .expect(500)
      .expect('Content-Type', 'application/json; charset=utf-8')
      .expect({ ok: false, error: 'Database failed' })
  })
})
